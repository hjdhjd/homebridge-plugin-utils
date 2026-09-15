[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / util

# util

TypeScript Utilities.

## Utilities

### HbpuAbortError

The canonical abort error used across `homebridge-plugin-utils`.

`HbpuAbortError` is a lightweight subclass of `Error` whose `name` field is one of the values in [HbpuAbortReason](#hbpuabortreason). It is the value passed to
`AbortController.abort(reason)` by every HBPU-owned resource class and is surfaced back to callers as a signal's `reason` or as the rejection of any HBPU-awaited
promise that ends because of an abort.

#### Remarks

The base class is intentionally minimal. Domain-specific context (FFmpeg exit code, MQTT packet id, etc.) travels on `cause` as a structured object rather
than as additional fields on this class, so that every consumer that catches an `HbpuAbortError` reads the same shape. Specialized subclasses (e.g.,
`FfmpegAbortError` carrying typed exit context) may be introduced later when there is a concrete need - not preemptively.

#### Example

```ts
import { HbpuAbortError, isHbpuAbortReason } from "homebridge-plugin-utils";

try {

  await recording.segments().next();
} catch(error: unknown) {

  if(isHbpuAbortReason(error, "replaced")) {

    // Stream was superseded; this is expected during a livestream discontinuity.
    return;
  }

  throw error;
}
```

#### Extends

- `Error`

#### Constructors

##### Constructor

```ts
new HbpuAbortError(reason, options?): HbpuAbortError;
```

Construct a new `HbpuAbortError`.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `reason` | [`HbpuAbortReason`](#hbpuabortreason) | The abort reason (also assigned to `.name`). |
| `options` | [`HbpuAbortErrorOptions`](#hbpuaborterroroptions) | Optional `cause` for structured diagnostic context, and an optional human-readable `message`. |

###### Returns

[`HbpuAbortError`](#hbpuaborterror)

###### Overrides

```ts
Error.constructor
```

#### Properties

| Property | Modifier | Type | Description | Overrides |
| ------ | ------ | ------ | ------ | ------ |
| <a id="name"></a> `name` | `readonly` | [`HbpuAbortReason`](#hbpuabortreason) | The tag. Matches one of [HbpuAbortReason](#hbpuabortreason). | `Error.name` |

***

### Watchdog

Re-armable inactivity watchdog.

Every long-lived resource class in this library that cares about liveness - an FFmpeg stream's return-port UDP socket, the fMP4 segment assembler's inter-segment
pacing, the RTP demuxer's inbound-packet cadence - composes a single `Watchdog` instance to implement the shared "abort if no activity within window" pattern.

The semantics are minimal on purpose:

  - `arm()` starts the window. If a previous arm is still pending, it is replaced; if the observed signal has already aborted or the watchdog has been disposed, the
    call is a no-op.
  - If nothing calls `arm()` again within `timeoutMs`, `onFire` runs - but only if the signal is still unaborted at that instant, so a last-moment concurrent abort
    wins the race and the callback is skipped.
  - When the observed signal aborts for any reason, the watchdog self-cleans its pending timer; the consumer never needs to unwire it at teardown.
  - `clear()` cancels any pending fire without aborting anything and leaves the watchdog re-armable.
  - `[Symbol.dispose]` clears the pending fire and marks the watchdog permanently dead: subsequent `arm()` calls are no-ops. This matches the scope-bound semantics
    callers expect from `using` - the resource is dead when the block exits, not merely quiescent.

The window is armed on the injected [Clock](clock.md#clock) - [systemClock](clock.md#systemclock) unless a caller supplies one - so a consumer that drives its waits on a controllable clock
drives this deadline from the same lever, and a composer between that consumer and this class passes its optional clock through without resolving it.

This is a `Disposable` (synchronous) rather than `AsyncDisposable` because cancelling a timer is synchronous; there is no background work to await.

#### Example

```ts
using watchdog = new Watchdog({

  onFire: () => this.#controller.abort(new HbpuAbortError("timeout")),
  signal: this.signal,
  timeoutMs: this.#inactivityWindowMs
});

// Each time a packet / segment / message arrives, re-arm so the fire never fires.
this.#source.on("data", () => watchdog.arm());
watchdog.arm();
```

#### Implements

- [`Disposable`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol/dispose)

#### Constructors

##### Constructor

```ts
new Watchdog(init): Watchdog;
```

Construct a new watchdog. The watchdog is dormant until the first `arm()` call, so construction itself schedules no timers.

A cleanup handler is registered on `init.signal` through [onAbort](#onabort) so the watchdog auto-cleans when the lifetime signal aborts - consumers do not need to
wire teardown manually. On a pre-aborted signal `onAbort` runs the cleanup inline; `clear()` is a no-op on a freshly-constructed watchdog (no timer has been
armed yet), so the pre-aborted path unwinds harmlessly. A later `arm()` short-circuits on the same aborted check, so no timer is ever scheduled either way.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `init` | [`WatchdogInit`](#watchdoginit) | Required init options. See [WatchdogInit](#watchdoginit). |

###### Returns

[`Watchdog`](#watchdog)

#### Methods

##### \[dispose\]()

```ts
dispose: void;
```

`Disposable` implementation. Clears any pending fire AND permanently disables the watchdog: after this runs, `arm()` is a no-op and no further `onFire` calls can
occur. This is the contract `using watchdog = new Watchdog(...)` relies on - the resource is dead when the block exits, not merely quiescent. Repeated
disposal is a no-op. Because the class does not own an abort controller, disposal does not signal anything to the rest of the system.

###### Returns

`void`

###### Implementation of

```ts
Disposable.[dispose]
```

##### arm()

```ts
arm(): void;
```

Start or restart the inactivity window. The pending timer (if any) is cancelled and a fresh one is scheduled for `timeoutMs` in the future. A no-op when the
observed signal has already aborted or the watchdog has been disposed - in either state there is nothing live to protect, and scheduling a timer would violate the
`using` contract callers rely on.

###### Returns

`void`

##### clear()

```ts
clear(): void;
```

Cancel any pending fire without aborting anything and without marking the watchdog as permanently dead. Subsequent `arm()` calls continue to work. Safe to call
when no arm is pending - repeat calls are no-ops.

###### Returns

`void`

***

### ExponentialBackoffOptions

Options accepted by [exponentialBackoff](#exponentialbackoff).

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="ceilingms"></a> `ceilingMs?` | `number` | The largest delay, in milliseconds, the ladder ever answers: once the doubling reaches this value the ladder holds here for every later attempt. Must be finite and positive. Defaults to 30000. |
| <a id="seedms"></a> `seedMs?` | `number` | The delay, in milliseconds, before attempt 2 - the first retry - doubled for each attempt after it. Must be finite and positive. Defaults to 1000. |

***

### HbpuAbortErrorOptions

Options accepted by [HbpuAbortError](#hbpuaborterror)'s constructor.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="cause"></a> `cause?` | `unknown` | The underlying cause of the abort. For `"failed"` reasons this is typically the upstream error. For `"failed"` exits from child processes, this is idiomatically a structured object carrying diagnostic context (e.g., `{ exitCode, exitSignal }`) - specialized subclasses may tighten this later. |
| <a id="message"></a> `message?` | `string` | Optional human-readable message. When omitted, the error's `message` defaults to the reason name, which is sufficient for name-based handling. |

***

### HomebridgePluginLogging

Logging interface for Homebridge plugins.

This interface defines the standard logging methods (`debug`, `info`, `warn`, `error`) that plugins should use to output log messages at different severity levels. It
is intended to be compatible with Homebridge's builtin logger and can be implemented by any custom logger used within Homebridge plugins.

#### Example

```ts
function example(log: HomebridgePluginLogging) {

  log.debug("Debug message: %s", "details");
  log.info("Informational message.");
  log.warn("Warning message!");
  log.error("Error message: %s", "problem");
}
```

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="debug"></a> `debug` | `readonly` | (`message`, ...`parameters`) => `void` | Logs a debug-level message. |
| <a id="error"></a> `error` | `readonly` | (`message`, ...`parameters`) => `void` | Logs an error-level message. |
| <a id="info"></a> `info` | `readonly` | (`message`, ...`parameters`) => `void` | Logs an info-level message. |
| <a id="warn"></a> `warn` | `readonly` | (`message`, ...`parameters`) => `void` | Logs a warning-level message. |

***

### RetryOptions

Options accepted by [retry](#retry).

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="attempts"></a> `attempts?` | `number` | Total number of attempts, including the first. Must be >= 1. Defaults to 3. Values less than 1 throw synchronously (rejected promise) at the top of `retry()`. Pass `Infinity` for unbounded attempts - the loop then terminates only on success, an abort, or a `shouldRetry` veto, never on an exhausted budget. |
| <a id="backoff"></a> `backoff?` | [`RetryBackoff`](#retrybackoff) | Backoff policy, invoked with the attempt number (1-indexed) about to be run. The returned value is the delay in milliseconds before running that attempt. See [RetryBackoff](#retrybackoff) for the attempt-numbering convention. Defaults to [defaultRetryBackoff](#defaultretrybackoff) (exponential with a 30-second ceiling); build a curve with a different seed or ceiling through [exponentialBackoff](#exponentialbackoff). |
| <a id="clock"></a> `clock?` | [`Clock`](clock.md#clock) | Optional time source for the between-attempt backoff waits. Defaults to [systemClock](clock.md#systemclock), whose `delay` IS the platform `node:timers/promises` `setTimeout`, so the default path is that same platform call with one indirection in front of it and no behavior change. Supplying a controllable clock (`TestClock`) puts the backoff schedule on virtual time, so a test asserts what the policy actually waited instead of waiting it out in real seconds. |
| <a id="shouldretry"></a> `shouldRetry?` | (`error`, `attemptNumber`) => `boolean` | Optional predicate consulted after an attempt throws and attempts remain. Receives the rejected error and the 1-indexed number of the attempt that just failed; return `false` to stop immediately and rethrow that error (no backoff wait, no further attempts), or `true` to retry per the backoff policy. When omitted, every error is retried until `attempts` is exhausted - the existing behavior, unchanged. This is the mechanism that lets a caller retry some failures and fail fast on others (e.g. retry network faults but give up on an authentication error) without owning the attempt loop itself. |
| <a id="signal"></a> `signal?` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | Optional abort signal. Aborting cancels any in-flight backoff wait and is forwarded verbatim to `operation` as its own signal argument, so well-behaved operations cancel too. An abort at any point - mid-attempt, mid-backoff, or before the first attempt - rejects the outer promise with the signal's reason. |

***

### WatchdogInit

Construction-time options for [Watchdog](#watchdog).

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="clock-1"></a> `clock?` | [`Clock`](clock.md#clock) | Optional time source the inactivity window is armed on. Defaults to [systemClock](clock.md#systemclock), whose `schedule` IS the global `setTimeout`, so the default path is that same platform call with one indirection in front of it and no behavior change. A test injects a `TestClock` so the window runs on virtual time alongside whatever else that clock drives. |
| <a id="onfire"></a> `onFire` | () => `void` | Callback invoked when the watchdog window lapses without a re-arm. Typically aborts an owning controller (`() => this.#controller.abort(new HbpuAbortError("timeout"))`) but the watchdog itself is agnostic about what the fire does. Runs only when the observed signal has not already aborted; if the signal fires before the timer, `onFire` is skipped entirely. |
| <a id="signal-1"></a> `signal` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | The lifetime signal the watchdog observes. When the signal aborts for any reason the pending timer is cleared and no further arms take effect. Typically the consumer's composed lifetime signal (`this.signal`) so both parent-initiated and internal aborts wind the watchdog down. |
| <a id="timeoutms"></a> `timeoutMs` | `number` | Inactivity window in milliseconds. The first `arm()` schedules a fire at now + `timeoutMs`; each subsequent `arm()` restarts the window. |

***

### DeepPartial

```ts
type DeepPartial<T> = { [P in keyof T]?: T[P] extends (infer I)[] ? DeepPartial<I>[] : DeepPartial<T[P]> };
```

A utility type that recursively makes all properties of an object, including nested objects, optional.

This should only be used on JSON objects. If used on classes, class methods will also be marked as optional.

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| `T` | The type to make recursively partial. |

#### Remarks

Credit for this type goes to: https://github.com/joonhocho/tsdef.

#### Example

```ts
type Original = {

  id: string;
  nested: { value: number };
};

// All properties, including nested ones, are optional.
type PartialObj = DeepPartial<Original>;

const obj: PartialObj = { nested: {} };
```

***

### DeepReadonly

```ts
type DeepReadonly<T> = { readonly [P in keyof T]: T[P] extends (infer I)[] ? DeepReadonly<I>[] : DeepReadonly<T[P]> };
```

A utility type that recursively makes all properties of an object, including nested objects, readonly.

This should only be used on JSON objects. If used on classes, class methods will also be marked as readonly.

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| `T` | The type to make recursively readonly. |

#### Remarks

Credit for this type goes to: https://github.com/joonhocho/tsdef.

#### Example

```ts
type Original = {

  id: string;
  nested: { value: number };
};

// All properties, including nested ones, are readonly.
type ReadonlyObj = DeepReadonly<Original>;

const obj: ReadonlyObj = { id: "a", nested: { value: 1 } };
// obj.id = "b"; // Error: cannot assign to readonly property.
```

***

### DispatchCallback

```ts
type DispatchCallback = (error?) => void;
```

The minimal completion-callback shape [guardedDispatch](#guardeddispatch) guards. HomeKit's camera-delegate callbacks (snapshot, prepare-stream, stream-request) each answer with
an optional leading `Error` and, in some cases, an optional trailing payload; every one is structurally assignable to this error-first shape, so `guardedDispatch`
serves them all without importing any HomeKit or hap-nodejs type. A richer callback that also carries a success payload is preserved through the generic parameter on
[guardedDispatch](#guardeddispatch), which keeps the caller's exact signature while still guarding it.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `error?` | `Error` |

#### Returns

`void`

***

### HbpuAbortReason

```ts
type HbpuAbortReason = "closed" | "failed" | "replaced" | "shutdown" | "timeout";
```

The canonical set of abort reasons used across `homebridge-plugin-utils`.

Every long-lived resource class in the library exposes an [AbortSignal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) whose abort reason is normally an [HbpuAbortError](#hbpuaborterror) carrying one of these names.
Consumers branch on the `.name` field. Platform errors produced by `AbortSignal.timeout()` and bare `controller.abort()` interoperate by matching names:
`TimeoutError` and `AbortError` from the platform both flow through the same branching paths unchanged.

#### Remarks

When to use each reason:

- `"closed"` - resource ended naturally (process exited with code 0, socket closed by peer, MQTT disconnected cleanly).
- `"failed"` - resource ended because of an error (non-zero exit, spawn ENOENT, upstream error). Attach the underlying error via `cause`.
- `"replaced"` - a newer operation superseded this one (new stream request, livestream discontinuity, new MQTT subscription overwriting the old handler).
- `"shutdown"` - orderly teardown from parent lifecycle (plugin stop, controller close, session end). Default when `abort()` is called with no reason.
- `"timeout"` - resource was stuck and exceeded a watchdog window. `AbortSignal.timeout()`'s platform `TimeoutError` carries a matching `.name`.

***

### Logger

```ts
type Logger = HomebridgePluginLogging | Logging;
```

Logger union accepted by FFmpeg subsystem APIs that interoperate with both Homebridge's built-in logger and the plugin-side [HomebridgePluginLogging](#homebridgepluginlogging) interface.
Provides one alias for sites that need this union, keeping the SSOT discipline applied elsewhere in the package consistent for the logger surface.

***

### Nullable

```ts
type Nullable<T> = T | null;
```

Utility type that allows a value to be either the given type or `null`.

This type is used to explicitly indicate that a variable, property, or return value may be either a specific type or `null`.

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| `T` | The type to make nullable. |

#### Example

```ts
let id: Nullable<string> = null;

// Later...
id = "device-001";
```

***

### PartialWithId

```ts
type PartialWithId<T, K> = Partial<T> & Pick<T, K>;
```

Makes all properties in `T` optional except for those specified by `K`, which remain required.

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| `T` | The base interface or type. |
| `K` *extends* keyof `T` | The keys of `T` that should remain required. |

#### Example

```ts
interface Device {

  id: string;
  name: string;
  mac: string;
}

type DeviceUpdate = PartialWithId<Device, "id">;

// Valid: Only 'id' is required, others are optional.
const update: DeviceUpdate = { id: "123" };

// Valid: Extra properties can be provided.
const another: DeviceUpdate = { id: "456", name: "SomeDevice" };

// Error: 'id' is missing.
const invalid: DeviceUpdate = { name: "SomeOtherDevice" }; // TypeScript error
```

***

### RetryBackoff

```ts
type RetryBackoff = (attempt) => number;
```

The shape of a backoff policy: the function [retry](#retry) consults between attempts to learn how long to wait before the next one.

`attempt` is the 1-indexed number of the attempt about to run, and it is never 1 - the first attempt runs immediately - so a policy's seed delay is the one it
answers for attempt 2. The answer is the delay, in milliseconds, to wait before running that attempt.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `attempt` | `number` |

#### Returns

`number`

***

### RunWithAbortOptions

```ts
type RunWithAbortOptions = 
  | {
  signal: AbortSignal;
  timeout?: number;
}
  | {
  timeout: number;
} & {
  clock?: Clock;
};
```

Options for [runWithAbort](#runwithabort). At least one of `signal` or `timeout` must be provided so there is always an abort mechanism. TypeScript enforces this at compile
time through a discriminated union - the "no abort mechanism" case is unrepresentable. `clock` intersects that union rather than joining either arm, because the
time source a timeout is armed on is independent of which abort mechanism the caller chose.

#### Type Declaration

| Name | Type |
| ------ | ------ |
| `clock?` | [`Clock`](clock.md#clock) |

***

### consoleLog

```ts
const consoleLog: HomebridgePluginLogging;
```

A shippable console-backed [HomebridgePluginLogging](#homebridgepluginlogging) for a plugin's Homebridge custom-UI server: `error`, `info`, and `warn` reach the console, and
`debug` discards its arguments.

A custom-UI server runs as a child process, and Config UI X captures that process's console output into the Homebridge UI log prefixed by the plugin's name, so a
line written here lands where the plugin's own lines land. `HomebridgePluginUiServer` hands the server no logger of its own, which makes the console the
sanctioned transport at that boundary and this constant the one place that shape is spelled.

The debug channel is silent by design. That child process carries no debug switch to gate on, and the wire-level detail a client narrates at debug would fill every
user's UI log for as long as the settings panel sits open...so what reaches the log is what a user acts on: failures at `error` and `warn`, lifecycle at `info`.
A server that does have a switch composes one rather than reaching for a variant of this - `debugGatedLog(consoleLog, isEnabled)` gates the debug channel and
leaves the other three alone.

A module-scope singleton for the reason [noOpLog](#nooplog) is one: the methods are stateless, so a single shared instance serves every caller.

#### Example

```ts
// Inside a plugin's homebridge-ui/server.js, where the console reaches the Homebridge UI log.
const feed = new StatusFeed({ controller, log: consoleLog });

consoleLog.info("Watching %s for status updates.", controller.name);
```

***

### NO\_OP\_DISPOSABLE

```ts
const NO_OP_DISPOSABLE: Disposable;
```

The shared inert `Disposable` an API answers with when there is nothing to cancel: [onAbort](#onabort)'s pre-aborted branch, which registered no listener, and the
timer registry's inert registrations, which armed no timer. A caller holds it exactly as it holds a live handle, so the nothing-to-cancel case needs no branch of
its own at any call site.

One module-scope instance serves every such call rather than allocating a fresh object and arrow pair per call, matching the other shared constants in this file.
Sharing is safe because the disposer is stateless, repeatable, and side-effect free: `[Symbol.dispose]()` can be invoked any number of times from any call site
without interference. It is frozen so that a holder cannot reassign the disposer out from under every other caller.

***

### noOpLog

```ts
const noOpLog: HomebridgePluginLogging;
```

A shippable no-op [HomebridgePluginLogging](#homebridgepluginlogging): every method accepts the logging signature and discards its arguments. A module-scope singleton - the methods are
stateless and side-effect-free, so one shared instance is safe to reuse everywhere - which keeps the omitted-logger path allocation-free. This is the SSOT no-op
logger: callers that need a CONCRETE logger but want no output default to it (e.g. a subsystem whose lower layer requires a non-optional logger), and the test-only
`silentLog` helper derives from it rather than re-declaring the empty sink.

***

### composeSignals()

```ts
function composeSignals(...signals): AbortSignal;
```

Compose one or more optional [AbortSignal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) sources into a single signal that aborts when any input aborts.

Collapses the recurring `parent ? AbortSignal.any([ parent, internal ]) : internal` pattern into a single call, used by every resource class in this library to
compose its lifetime signal. Filters out `undefined` inputs, returns the sole defined signal unchanged (no unnecessary `any()` wrapper), and composes two or more
defined signals with `AbortSignal.any()`.
Throws a [TypeError](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/TypeError) when every input is `undefined`, because a class whose lifetime is defined by a signal must always have at least one concrete signal to
compose against.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| ...`signals` | ( \| [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) \| `undefined`)[] | Ordered list of signal sources. `undefined` entries are filtered out; order is preserved among defined entries. |

#### Returns

[`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal)

The single defined signal when only one was supplied; otherwise a new signal that aborts as soon as any input aborts, carrying the first aborting input's
         reason as its own `reason`.

#### Throws

`TypeError` if every input is `undefined` - the caller passed no concrete signal to compose.

#### Example

```ts
// Class constructor composing an optional parent signal with the internal controller's signal.
this.signal = composeSignals(init.signal, this.#controller.signal);

// Per-call composition of the class signal with a caller-supplied per-call signal.
const composed = composeSignals(this.signal, init.signal);

// Compose an optional caller signal with a derived watchdog timeout.
const composed = composeSignals(init.signal, clock.timeout(PROBE_DEFAULT_TIMEOUT_MS));
```

***

### debugGatedLog()

```ts
function debugGatedLog(base, isEnabled): HomebridgePluginLogging;
```

Derive a config-gated debug [HomebridgePluginLogging](#homebridgepluginlogging) from a base logger. The `debug` level emits through the base logger's `warn` channel when `isEnabled`
answers `true`, and is dropped without touching its arguments when it answers `false`. The `error`, `info`, and `warn` levels pass straight through to the
corresponding base level, exactly as [prefixedLog](#prefixedlog) does, so the gate reaches the debug channel and nothing else.

Warn is the emission channel because Homebridge suppresses its native DEBUG channel unless Homebridge's own global debug switch is on. A plugin that offers users
an opt-in debug setting of its own therefore has to emit at a level Homebridge always prints, and warn additionally marks the line as diagnostic rather than
folding it into the ordinary informational stream. The consequence runs in the other direction too, deliberately: a gate that answers `false` drops the line no
matter what Homebridge's switch is doing, so the plugin's own setting is the single answer to whether this user wants debug output.

The predicate is evaluated on every call, which is what keeps it honest against live configuration: `() => config.debug === true` reflects a setting the user just
changed on the very next line, while a boolean captured when the wrapper was built freezes the gate at whatever it was then. The same shape carries scope without
any per-call plumbing - a plugin whose debug setting resolves per device passes a closure over its own option lookup, and the device that lookup resolves against
lives in the closure rather than being threaded through each logging call.

Compose with [prefixedLog](#prefixedlog) gate-outermost, as `debugGatedLog(prefixedLog(base, prefix), isEnabled)`, so a suppressed debug line pays for the predicate and
nothing else. The reverse nesting builds the prefixed string before the gate ever runs, which is precisely the work the gate exists to skip. A base that is
itself already gated needs no special handling: a device that re-gates outermost around a `prefixedLog` over a platform's own gated logger pays one predicate
to drop a suppressed line, since the outer gate returns before the inner one is ever consulted.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `base` | [`Logger`](#logger) | The logger that receives the passed-through calls and the gated debug output. |
| `isEnabled` | () => `boolean` | Predicate deciding whether a debug line is emitted, evaluated on every `debug` call. |

#### Returns

[`HomebridgePluginLogging`](#homebridgepluginlogging)

A [HomebridgePluginLogging](#homebridgepluginlogging) whose `debug` level is gated and routed to `base.warn`, and whose other levels route to the matching level of `base`.

#### Example

```ts
const log = debugGatedLog(prefixedLog(platformLog, () => this.name), () => this.config.debug === true);

log.debug("Polling returned %d devices.", devices.length);
```

***

### defaultRetryBackoff()

```ts
function defaultRetryBackoff(attempt): number;
```

The default backoff policy used by [retry](#retry): [exponentialBackoff](#exponentialbackoff) at its defaults - exponential with a 30-second ceiling, starting at 1 second for the
second attempt (`attempt = 2`).

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `attempt` | `number` | The attempt number about to be run (1-indexed; never called with `attempt === 1`, since the first attempt runs immediately). |

#### Returns

`number`

The delay, in milliseconds, to wait before executing `attempt`.

***

### exponentialBackoff()

```ts
function exponentialBackoff(options?): RetryBackoff;
```

Build an exponential backoff policy: a seed delay doubled for each successive attempt, never above a ceiling.

This is the one exponential ladder in the library...the default retry policy ([defaultRetryBackoff](#defaultretrybackoff)) and the log client's reconnect curve both derive from
it, so the formula and its attempt numbering live in one place. The numbering is [RetryBackoff](#retrybackoff)'s: [retry](#retry) consults the policy with the 1-indexed
attempt about to run and never with `attempt === 1`, so `seedMs` is the delay before attempt 2 and `attempt - 2` is the zero-based exponent. What comes back is
exactly what [RetryOptions.backoff](#backoff) accepts. Jitter is deliberately the caller's, composed on top of the ladder rather than offered as an option here: the
useful jitter models differ in kind - a fraction of the computed delay, an absolute millisecond spread a user configures - so the ladder answers the bare curve
and each caller spreads it the way its own fleet needs.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`ExponentialBackoffOptions`](#exponentialbackoffoptions) | The ladder's seed and ceiling. See [ExponentialBackoffOptions](#exponentialbackoffoptions). |

#### Returns

[`RetryBackoff`](#retrybackoff)

A backoff policy answering the delay, in milliseconds, to wait before the attempt it is given.

#### Throws

`Error` if `seedMs` or `ceilingMs` is not a finite, positive number.

#### Example

```ts
import { exponentialBackoff, retry } from "homebridge-plugin-utils";

// A ladder with a one-minute ceiling, handed to retry as its policy.
const device = await retry(async (signal) => fetchDevice(id, { signal }), { attempts: 5, backoff: exponentialBackoff({ ceilingMs: 60000 }) });

// Jitter composed on top of the same ladder.
const ladder = exponentialBackoff({ ceilingMs: 60000 });
const spread = (attempt: number): number => ladder(attempt) + Math.round(Math.random() * 250);
```

***

### formatErrorMessage()

```ts
function formatErrorMessage(error): string;
```

Render an arbitrary thrown value as a clean log-suffix string. Real `Error` instances surface their `.message`; everything else is coerced through `String(...)`.
A trailing period is stripped in either case so the embedding log line (which itself ends in a period) does not produce ".." at the end of the rendered output.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `error` | `unknown` | The thrown value, typically caught from a `try` block or rejected Promise. |

#### Returns

`string`

The cleaned message ready to interpolate into a log format string.

#### Example

```ts
try {

  await someOperation();
} catch(error) {

  log.error("Operation failed: %s.", formatErrorMessage(error));
}
```

***

### formatUrlHost()

```ts
function formatUrlHost(host): string;
```

Format a host for a URL authority, wrapping an IPv6 literal in square brackets as the URL grammar requires.

A literal IPv6 address carries colons, which collide with the authority's own host-port separator, so it has to be bracketed: `[::1]:8581`. A hostname, an
IPv4 address, and a literal the caller has already bracketed pass through untouched. A literal carrying a zone - `fe80::1%en0`, the form the mDNS browser
stamps on a link-local address so a consumer knows which link it is reachable through - is refused, because a URL authority has no place for a zone and the
platform's own refusal says only "Invalid URL", naming neither the address nor what is wrong with it.

Detection reads `isIP` rather than looking for a colon, so a hostname carrying a port-like tail is never mistaken for a literal. The zone is tested before the
bare form because `isIP` reads a zoned literal as IPv6 too, and bracketing one would compose an authority the URL parser rejects further downstream.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `host` | `string` | The hostname or address to place in a URL authority. |

#### Returns

`string`

The host as the authority carries it.

#### Throws

If `host` is an IPv6 literal carrying a zone, naming the address.

#### Example

```ts
const origin = new URL("http://" + formatUrlHost(address) + ":80/");
```

***

### guardedDispatch()

#### Call Signature

```ts
function guardedDispatch<C>(options): void;
```

Run an async handler that HomeKit invokes without awaiting - a camera-delegate method whose interface return type is `void` - so a rejection can never float as an
unhandled rejection and the delegate's completion callback is answered exactly once.

HomeKit's camera-delegate methods (snapshot, prepare-stream, stream-request) are declared to return `void` yet are naturally written as `async`. Calling an async
method in that position discards its promise: a rejection surfaces as a process-level unhandled rejection, and if the method faulted before answering its callback,
HomeKit waits forever for a response that never comes. `guardedDispatch` closes both gaps. It owns a once-guard around the real callback and hands the guarded callback
to `handler`, so however the handler behaves - answered then faulted, faulted before answering, or answered twice by mistake - the real callback fires exactly once:
the first answer wins; a fault after an answer is logged and the earlier answer stands; a fault before any answer is delivered to HomeKit through the callback itself.
The handler's promise is marked observed through [markHandled](mark-handled.md#markhandled), so nothing floats.

##### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| `C` *extends* [`DispatchCallback`](#dispatchcallback) | The caller's exact callback signature. Constrained to [DispatchCallback](#dispatchcallback) (error-first) so any HomeKit delegate callback fits, while preserving a richer signature - one that also passes a snapshot buffer or stream response - for the handler to answer with. |

##### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | \{ `callback`: `C`; `handler`: (`callback`) => [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\>; `label`: `string`; `log`: [`Logger`](#logger); \} | Dispatch inputs. |
| `options.callback` | `C` | The real completion callback HomeKit supplied. It is wrapped in a once-guard and never invoked more than once. |
| `options.handler` | (`callback`) => [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\> | The async work, given the guarded callback to answer with. A rejection, or a synchronous throw, is caught: while the callback is still open it receives the error, otherwise the error is logged. |
| `options.label` | `string` | A short human-readable name for the operation (for example `"snapshot request"`), interpolated into the failure log line. |
| `options.log` | [`Logger`](#logger) | The logger a post-answer fault is reported through. |

##### Returns

`void`

##### Example

```ts
import { guardedDispatch } from "homebridge-plugin-utils";

// A snapshot delegate HomeKit calls without awaiting. The method itself returns void; the async work and its one-shot callback are handed to guardedDispatch.
public handleSnapshotRequest(request: SnapshotRequest, callback: SnapshotRequestCallback): void {

  guardedDispatch({ callback, handler: (answer) => this.snapshot(request, answer), label: "snapshot request", log: this.log });
}
```

#### Call Signature

```ts
function guardedDispatch(options): void;
```

Run an async, callback-less handler that HomeKit (or any caller) invokes without awaiting, so a rejection can never float as an unhandled rejection. With no callback
to carry a failure back, a fault is simply logged.

##### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | \{ `handler`: () => [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\>; `label`: `string`; `log`: [`Logger`](#logger); \} | Dispatch inputs. |
| `options.handler` | () => [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\> | The async work to run. A rejection, or a synchronous throw, is caught and logged. |
| `options.label` | `string` | A short human-readable name for the operation (for example `"recording activation"`), interpolated into the failure log line. |
| `options.log` | [`Logger`](#logger) | The logger a fault is reported through. |

##### Returns

`void`

##### Example

```ts
import { guardedDispatch } from "homebridge-plugin-utils";

// A recording-state update HomeKit calls without awaiting. There is no callback, so a fault is logged rather than reported back to HomeKit.
public updateRecordingActive(active: boolean): void {

  guardedDispatch({ handler: () => this.applyRecordingActive(active), label: "recording activation", log: this.log });
}
```

***

### hasErrorCode()

```ts
function hasErrorCode<C>(error, code): error is Error & { code: C };
```

Test whether an unknown thrown value is an `Error` carrying a specific string `code`, narrowing it so the caller can read that code without a cast.

Two error families spell a string `code` and both are thrown as `unknown` into a `catch`: Node's own errno errors, where `code` is the platform's symbolic name
(`"EADDRINUSE"` for a port already bound, `"ENOENT"` for a path that does not exist, `"ENOTFOUND"` for a name that does not resolve), and library errors that adopt
the same convention to give callers something stable to branch on. Asking "is this that failure?" is a three-part check - an `Error`, an own `code` property, and the
value itself - and writing it inline at each site is what lets one site quietly drop a part and start matching a plain object that merely carries the field.

The generic keeps the caller's literal code in the narrowed type, the way [isHbpuAbortReason](#ishbpuabortreason) keeps its reason, so a branch that matched `"EADDRINUSE"` reads
`error.code` as that literal rather than as a widened `string`.

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| `C` *extends* `string` | The specific code being matched. Defaulted by inference from `code`. |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `error` | `unknown` | The value to test, typically a `catch` binding. |
| `code` | `C` | The code to match, compared with strict equality. |

#### Returns

`error is Error & { code: C }`

`true` when `error` is an `Error` whose `code` property is exactly `code`.

#### Example

```ts
import { hasErrorCode } from "homebridge-plugin-utils";

try {

  await bind();
} catch(error: unknown) {

  // A port somebody else holds is worth waiting out; anything else is a real failure and is rethrown.
  if(!hasErrorCode(error, "EADDRINUSE")) {

    throw error;
  }
}
```

***

### isHbpuAbortError()

```ts
function isHbpuAbortError(error): error is HbpuAbortError;
```

Type guard: returns `true` if `error` is an [HbpuAbortError](#hbpuaborterror).

Use this to distinguish HBPU's canonical abort errors from arbitrary thrown values, without nesting `instanceof` checks.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `error` | `unknown` | The value to test. |

#### Returns

`error is HbpuAbortError`

`true` if `error` is an `HbpuAbortError` instance.

***

### isHbpuAbortReason()

```ts
function isHbpuAbortReason<R>(error, reason): error is HbpuAbortError & { name: R };
```

Convenience type predicate: returns `true` if `error` is an [HbpuAbortError](#hbpuaborterror) whose `.name` matches `reason`, and narrows the type so callers can read
`error.cause` and related fields without further casts.

Collapses the common "is this an HBPU abort, and was it this specific reason?" question into a single call, avoiding the `instanceof` + `.name` nesting that appears
throughout consuming code. The generic parameter `R` preserves the specific reason string in the narrowed type so callers that distinguish further by name get the
literal narrowed form automatically.

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| `R` *extends* [`HbpuAbortReason`](#hbpuabortreason) | The specific reason being matched. Defaulted by inference from `reason`. |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `error` | `unknown` | The value to test. |
| `reason` | `R` | The abort reason to match. |

#### Returns

`error is HbpuAbortError & { name: R }`

`true` if `error` is an `HbpuAbortError` with the given reason.

***

### isTimeoutReason()

```ts
function isTimeoutReason(reason): boolean;
```

Test whether an abort reason indicates a timeout. Matches both the canonical [HbpuAbortError](#hbpuaborterror) with `"timeout"` name - produced by project watchdogs
([Watchdog](#watchdog), the inactivity monitors on `FfmpegStreamingProcess` / `RtpDemuxer` / `Mp4SegmentAssembler`) - and the platform [DOMException](https://developer.mozilla.org/en-US/docs/Web/API/DOMException)/`Error` whose
`.name === "TimeoutError"` - produced by `AbortSignal.timeout()`. Consumers branch on a single predicate regardless of which code path originated the timeout.

Exists because every long-lived resource class exposes an `isTimedOut` getter with identical branching logic; routing all of them through this single predicate
enforces one taxonomy and eliminates drift if the project ever needs to add, say, a third timeout shape (e.g., an upstream-framework cancellation).

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `reason` | `unknown` | Any value found on `AbortSignal.reason`. Plain objects, non-errors, and `undefined` all return `false`. |

#### Returns

`boolean`

`true` when the reason is a timeout in either supported shape.

***

### loopFaultReporter()

```ts
function loopFaultReporter(log, label): (error) => void;
```

Build the standard [superviseLoop](#superviseloop) `onError` handler: a reporter that logs a faulted supervised loop with one canonical message, rendering the thrown value
through [formatErrorMessage](#formaterrormessage).

`superviseLoop` is deliberately logging-free - it owns the swallow-on-abort-versus-surface-once control flow and nothing else, so the wording of what to say when a
loop dies lives here, in an explicitly logging companion, never in the primitive itself. Plugins that supervise the same shape of loop - a client observe-loop bound
to a terminal shutdown signal with no auto-respawn - all owe the operator the same report: the fault is terminal until the next restart, so the message says exactly
that and hands over the one actionable hint. Single-sourcing the template and the formatting here keeps that report from being hand-copied (and quietly drifting)
across plugins that share no ancestor - the same "no shared home, so a free function is the home" situation [superviseLoop](#superviseloop) itself answers.

The wording is specific to that bound-to-shutdown, no-respawn lifecycle. A consumer whose loops recover on their own - reconnecting, re-arming, respawning - has
different news to deliver and should pass its own `onError` to [superviseLoop](#superviseloop) rather than this reporter.

[superviseStream](#supervisestream) is the second envelope this reporter serves: it delivers a fault through the same `(error) => void` handler, so a supervised value stream
reports exactly as a supervised loop does.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `log` | [`HomebridgePluginLogging`](#homebridgepluginlogging) | The plugin logger the report is written to; its `error` method receives the canonical format string and arguments. |
| `label` | `string` | The loop's name, interpolated as the `%s` in `"HomeKit updates for %s ..."` so anyone reading the log can tell which supervised loop died. |

#### Returns

The `(error) => void` handler to hand to [superviseLoop](#superviseloop)'s `onError`. It logs exactly once per fault and returns nothing.

(`error`) => `void`

#### Example

```ts
import { loopFaultReporter, superviseLoop } from "homebridge-plugin-utils";

// The standard supervised observer: swallow on shutdown, and on a genuine fault log the canonical "<label> loop died, restart to recover" report exactly once.
void superviseLoop({

  loop: (signal) => this.observeMembership(signal),
  onError: loopFaultReporter(this.log, "membership"),
  signal: this.signal
});
```

***

### membershipDelta()

```ts
function membershipDelta<T>(currentIds, configuredIds): {
  toAdd: T[];
  toRemove: T[];
};
```

Compute the membership delta between the ids a source currently reports and the ids already configured: `toAdd` holds the current ids that are not yet
configured, `toRemove` the configured ids that are no longer current.

The use case this exists for is reconciliation: a plugin asks its source what exists, holds the set of things it has already configured, and needs to know
what arrived and what left before it touches anything. One diff answers both halves at once, and isolating it lets the reconcile that consumes it read as a
decision followed by its effects rather than as two membership walks tangled into the work they drive. What the ids mean, and what adding or removing one
entails, stay entirely with the caller...this decides only which ids fall on which side.

Each direction is filtered against a `Set` built from the opposing input, so the cost is linear in the two lengths rather than their product. The filtering
walks the original arrays rather than the sets, which is what keeps each output in the order its own input arrived in - the result is never sorted - and what
keeps duplicates: an id appearing twice in `currentIds` and absent from `configuredIds` appears twice in `toAdd`. Identity is SameValueZero, the comparison
`Set` itself uses, so `NaN` matches `NaN` and `0` matches `-0`.

Neither input is mutated, and the returned arrays are freshly built, so a caller is free to sort or splice them without disturbing what it passed in.

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| `T` | The id type, commonly a string or a numeric identifier. |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `currentIds` | readonly `T`[] | The ids the source currently reports. |
| `configuredIds` | readonly `T`[] | The ids already configured. |

#### Returns

```ts
{
  toAdd: T[];
  toRemove: T[];
}
```

An object whose `toAdd` holds the current ids that are not configured and whose `toRemove` holds the configured ids that are not current.

| Name | Type |
| ------ | ------ |
| `toAdd` | `T`[] |
| `toRemove` | `T`[] |

#### Example

```ts
const { toAdd, toRemove } = membershipDelta(devices.map((device) => device.id), [...this.configured.keys()]);

for(const id of toRemove) {

  this.retire(id);
}
```

***

### onAbort()

```ts
function onAbort(signal, handler): Disposable;
```

Register a one-shot abort handler on `signal` and return a [Disposable](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol/dispose) whose `[Symbol.dispose]` removes the listener. If `signal` is already aborted at
call time, `handler` runs inline and the returned handle is a no-op disposer.

Closes the well-known pitfall in `AbortSignal.addEventListener("abort", ...)`: listeners attached to an already-aborted signal **do not fire**, so constructors
that take a parent signal and attach teardown logic via `addEventListener` silently skip that teardown when the parent is pre-aborted. This helper unifies the
register-or-dispatch-immediately shape so every caller handles both cases without re-implementing the check.

Returning a `Disposable` serves more than one usage pattern through one primitive:

- **Long-lived resource-class registrations** (the common case): every HBPU resource class registers its `#teardown` handler in its constructor, intending the
  listener to live until the composed signal aborts. These callers discard the return value; the `{ once: true }` listener auto-unregisters on fire.
- **Scope-bound transient registrations**: observers that only need the listener for a bounded scope (e.g., [waitWithSignal](#waitwithsignal)) capture the handle with
  `using` so the listener is deterministically removed on scope exit even when the promise resolves before the signal aborts. This prevents listener accumulation
  on long-lived signals that see many short waits.

The handler runs at most once: on normal abort, via the `{ once: true }` option on `addEventListener`; on pre-aborted signals, via a direct call here. The caller
still decides what to do with the rest of its setup - a constructor that wants to short-circuit further initialization after a pre-aborted signal typically pairs
this call with a subsequent `if(signal.aborted) return;` check.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `signal` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | The abort signal to observe. |
| `handler` | () => `void` | The teardown or cleanup action to run once on abort. Invoked synchronously when `signal.aborted` is already `true` at call time; otherwise attached as a one-shot `"abort"` listener. |

#### Returns

[`Disposable`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol/dispose)

A [Disposable](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol/dispose) handle. `[Symbol.dispose]` removes the abort listener (no-op on the pre-aborted path and after the listener has already fired).

#### Examples

```ts
// Long-lived resource-class registration: discard the returned disposer. The listener lives until the composed signal aborts and `{ once: true }` cleans it up.
constructor(init: { signal?: AbortSignal }) {

  this.signal = composeSignals(init.signal, this.#controller.signal);

  onAbort(this.signal, () => this.#teardown());

  if(this.signal.aborted) {

    return;
  }

  // ...proceed with setup that only makes sense on a live signal.
}
```

```ts
// Scope-bound transient registration: capture the handle with `using` so the listener auto-removes when the scope exits, even if the signal never aborts.
async function abortableWait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {

  using _registration = onAbort(signal, () => {
    // Abort-driven action goes here.
  });

  // `return await promise` (not a bare `return promise`) is required inside an async function. `using` disposes when the enclosing function body finishes
  // executing, and without an `await` the body finishes synchronously at the `return` statement - even though the returned promise is still pending. The
  // listener would therefore be removed the instant the function returned, well before the promise settles. Adding `await` creates a suspension point that
  // keeps the `using` scope alive until the promise actually settles, which is what the "scope-bound registration" pattern relies on.
  return await promise;
}
```

***

### prefixedLog()

```ts
function prefixedLog(base, prefix): HomebridgePluginLogging;
```

Derive a prefixed [HomebridgePluginLogging](#homebridgepluginlogging) from a base logger. Each level prepends the supplied prefix and the family's ": " separator to the
message and passes the message and its parameters through to the base logger unchanged, so formatting happens exactly once, at the sink, behind
whatever gates the sink applies. The prefix is a supplier evaluated on every call: identity that can change at runtime (a renamed accessory, a
retitled controller) flows into the very next line without any re-wiring, and a captured string can never freeze it.

Printf-style tokens behave as if the caller had written the prefix into its own format string: the composed prefix-plus-message string is what meets
the parameters at the sink.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `base` | [`Logger`](#logger) | The logger that receives the prefixed calls and owns formatting and gating. |
| `prefix` | () => `string` | Supplier for the prefix, evaluated on every call. |

#### Returns

[`HomebridgePluginLogging`](#homebridgepluginlogging)

A [HomebridgePluginLogging](#homebridgepluginlogging) whose levels route to the corresponding levels of `base`.

#### Example

```ts
const log = prefixedLog(platformLog, () => this.name);

log.info("Connected to %s.", address);
```

***

### retry()

```ts
function retry<T>(operation, options?): Promise<T>;
```

Retry an async operation with configurable attempts and backoff, with first-class abort signal support.

The operation receives the caller's [AbortSignal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) directly (or a permanent never-aborted sentinel when no caller signal was provided). Well-behaved operations
forward this signal to any cancellation-aware API they call (`fetch`, `events.once`, etc.) so the in-flight attempt actually cancels. Between-attempt waits run through
the injected [Clock](clock.md#clock) with the signal - [systemClock](clock.md#systemclock) unless the caller supplies one - so abort also interrupts the backoff, and a test that supplies a
controllable clock drives the whole backoff schedule on virtual time.

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| `T` | The successful resolution type of `operation`. |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `operation` | (`signal`) => [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`T`\> | The async work to perform. Receives the composed abort signal; must resolve with a value on success, or throw/reject on failure. |
| `options` | [`RetryOptions`](#retryoptions) | Retry options. See [RetryOptions](#retryoptions). |

#### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`T`\>

Resolves with the first successful operation result. Rejects with the operation's error once the attempt budget is exhausted or a `shouldRetry` predicate
vetoes a further attempt, or with the signal's reason if aborted mid-attempt or mid-backoff.

#### Example

```ts
import { retry } from "homebridge-plugin-utils";

const controller = new AbortController();

const device = await retry(async (signal) => fetchDevice(id, { signal }), {

  attempts: 5,
  backoff: (attempt) => 1000 * attempt,
  signal: controller.signal
});
```

***

### runWithAbort()

```ts
function runWithAbort<T>(fn, options): Promise<Nullable<T>>;
```

Run an abortable operation with signal-based cancellation.

The caller provides a factory function that receives an [AbortSignal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal). The signal fires when the timeout expires, when the caller's own signal aborts, or
whichever comes first when both are provided. The factory must forward this signal to any API that accepts one (`events.once`, `fetch`, Node stream methods, etc.) so
the underlying work is actually cancelled. When the signal fires and the factory rejects, the rejection is caught and `null` is returned. Genuine (non-abort) errors
from the factory propagate normally.

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| `T` | The type of value the factory's promise resolves with. |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `fn` | (`signal`) => [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`T`\> | A factory that receives the composed abort signal and returns the promise to await. |
| `options` | [`RunWithAbortOptions`](#runwithabortoptions) | Abort options. Provide `timeout` (milliseconds), an external `signal`, or both, plus the optional `clock` the timeout is armed on. Defaults to [systemClock](clock.md#systemclock), whose `timeout` IS `AbortSignal.timeout`, so the default path is that same platform call with one indirection in front of it; supplying a controllable clock puts the deadline on virtual time. |

#### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<[`Nullable`](#nullable)\<`T`\>\>

Resolves with the factory's result if it completes before abort, or `null` if the signal fires first.

#### Example

```ts
// Timeout only - cancel after 500ms.
const result = await runWithAbort((signal) => fetch(url, { signal }), { timeout: 500 });

// External signal only - cancel on demand.
const controller = new AbortController();
const result2 = await runWithAbort((signal) => once(emitter, "data", { signal }), { signal: controller.signal });
controller.abort();

// Both - cancel on demand or after 5 seconds, whichever comes first.
const result3 = await runWithAbort((signal) => once(emitter, "data", { signal }), { signal: controller.signal, timeout: 5000 });
```

***

### sameEntries()

```ts
function sameEntries<T>(
   a, 
   b, 
   same
): boolean;
```

Compare two arrays entry by entry, deciding equality of each pair through a caller-supplied comparator.

The use case this exists for is persist-on-change: a plugin holds the last state it wrote, computes the current state, and wants to write only when something
actually differs. The entries are usually small records - a device summary, a channel row - whose equality is a matter of the two or three fields that matter to
the caller rather than a deep structural comparison, and the comparator is where that judgement lives.

Arrays of different lengths are unequal without any comparison. Otherwise the walk is index-wise and short-circuits at the first unequal pair, so the cost is the
length of the common prefix rather than the whole array.

Undefined slots are settled before the comparator is consulted, which is what keeps a sparse or short-read array from slipping past a comparator that reads
fields off its arguments: a pair with exactly one undefined side is unequal, a pair with both sides undefined is equal, and the comparator runs only when both
sides are present. A comparator therefore never has to defend against an undefined argument.

Node-side by scope, and deliberately so. It has no runtime dependencies of its own, but util.ts is where the library's Node-side helpers live and every filed
consumer of this one is Node-side; the browser-safe surface is formatters.ts, which is the SSOT for formatting alone, by name and by scope. Should a browser-side
consumer ever appear, relocating this is a deliberate, versioned act rather than something to pre-empt here.

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| `T` | The entry type. |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `a` | readonly `T`[] | The first array. |
| `b` | readonly `T`[] | The second array. |
| `same` | (`x`, `y`) => `boolean` | Equality predicate for one pair of entries, invoked only when both entries are present. |

#### Returns

`boolean`

True when the arrays are the same length and every pair is equal, false otherwise.

#### Example

```ts
// Write only when the device list actually changed.
if(!sameEntries(this.persisted, devices, (x, y) => (x.id === y.id) && (x.name === y.name))) {

  await this.persist(devices);
}
```

***

### sanitizeName()

```ts
function sanitizeName(name): string;
```

Sanitize an accessory name according to HomeKit naming conventions.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `name` | `string` | The name to validate. |

#### Returns

`string`

Returns the HomeKit-sanitized version of the name, replacing invalid characters with a space and squashing multiple spaces.

#### Remarks

This sanitizes names using [HomeKit's naming rulesets](https://developer.apple.com/design/human-interface-guidelines/homekit#Help-people-choose-useful-names)
and HAP specification documentation:

- Starts and ends with a letter or number. Exception: may end with a period.
- May have the following special characters: -"',.#&.
- Must not include emojis.

#### Example

```ts
sanitizeName("Test|Switch")
```

Returns: `Test Switch`, replacing the pipe (an invalid character in HomeKit's naming ruleset) with a space.

***

### superviseLoop()

```ts
function superviseLoop(options): Promise<void>;
```

Supervise a detached, signal-bound async loop: run the loop, resolve quietly when it ends or its signal aborts, and route any genuine fault to a caller-supplied
handler exactly once.

Resilient background loops - membership observers, reachability probes, telemetry firehoses - all share one subtle, correctness-critical rule: a throw is a
*fault* only when we did not cause it. When the bound signal is aborted, a throw is the orderly unwinding of a loop the caller already tore down, so it is swallowed
silently. Any other throw is a genuine fault and is handed to `onError` exactly once. Hand-copying that swallow-on-abort-versus-surface-once distinction across
call sites that share no ancestor is how it drifts apart; owning it in one generic primitive is how it stays consistent.

The home is here, beside [composeSignals](#composesignals), because the envelope is fully generic - it carries no logging policy, no message wording, and makes no detachment
decision of its own. When the loops to supervise live on objects with no common base class (so the shared logic cannot be a method), this free function is the only
shared home. The returned promise NEVER rejects as a consequence of the loop: it resolves when the loop returns (a finite source ending), when the signal aborts
(orderly teardown, swallowed), or once a genuine fault has been delivered to `onError`. The caller owns the rest - `void` the result to fire-and-forget a detached
loop, or `await` it for orderly shutdown and in tests.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | \{ `loop`: (`signal`) => [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\>; `onError`: (`error`) => `void`; `signal`: [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal); \} | Supervision inputs. |
| `options.loop` | (`signal`) => [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\> | The loop to run, once. It receives the bound [AbortSignal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) so it can wire cancellation into `observe()` / `fetch()` / stream reads. |
| `options.onError` | (`error`) => `void` | Invoked at most once, with the thrown value unchanged, when the loop faults while the signal is NOT aborted. It carries the caller's entire fault policy (logging, wording, recovery), which is why the primitive itself stays logging-free. A throw from `onError` is a defect in the handler and propagates - the never-rejects guarantee covers the loop, not the handler. |
| `options.signal` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | The signal the loop is bound to. Its aborted state is the single source of truth for "did we cause this throw?": aborted means swallow, not aborted means surface. |

#### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\>

A promise that resolves when the loop ends, the signal aborts, or a fault has been delivered to `onError`. It does not reject for any of those outcomes.

#### Example

```ts
import { superviseLoop } from "homebridge-plugin-utils";

// Fire-and-forget a detached observer that survives transient faults until its controller is torn down. Aborting `this.signal` unwinds the loop silently; any other
// failure is surfaced once through the caller's own wording.
void superviseLoop({

  loop: async (signal) => {

    for await (const event of client.observe(selector, { signal })) {

      this.handle(event);
    }
  },
  onError: (error) => this.log.error("The membership observer stopped unexpectedly and will not restart until the next reload: %s", formatErrorMessage(error)),
  signal: this.signal
});
```

***

### superviseStream()

```ts
function superviseStream<T>(options): AsyncGenerator<T, void, undefined>;
```

Supervise a signal-bound async stream: iterate a source, yield every value through to the consumer, end quietly when the source ends or its signal aborts, and route
any genuine fault to a caller-supplied handler exactly once.

This is [superviseLoop](#superviseloop)'s guarantees translated to the value path. `superviseLoop` supervises a loop that keeps its results to itself; `superviseStream`
supervises one that has values to hand back, so a caller can feed several sinks from a single source, or transform what it receives, without owning the
swallow-on-abort-versus-surface-once rule itself. That rule is identical here: a throw is a *fault* only when we did not cause it. With the bound signal aborted, a
throw is the orderly unwinding of a source the caller already tore down, so it is swallowed and the stream simply ends. Any other throw is genuine, is handed to
`onError` exactly once, and then the stream ends. The stream NEVER throws a source-originated failure at its consumer - a `for await` over it exits normally in
every one of those cases - so the consumer writes no error handling for the faults this envelope already owns. A throw from `onError` is a defect in the handler and
propagates: the never-throws guarantee covers the source, not the handler.

A signal that is already aborted ends the stream before `source` is invoked at all, so a caller that has already torn down never pays for the setup its source would
do. A consumer that stops early - `break`, `return`, or a throw from its own loop body - drives this generator's return path, which unwinds the `for await` and runs
the source's own `finally`, so a source holding a subscription or a handle releases it with nothing arranged by the consumer.

The envelope is unicast by design: it supervises one consumer's iteration. Fan-out is composition the consumer owns - hand each value to the sinks it has - because a
broadcast primitive would have to decide buffering and slow-consumer policy, which belongs to the caller rather than to a supervision envelope.

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| `T` | The type of value the source yields. |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | \{ `onError`: (`error`) => `void`; `signal`: [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal); `source`: (`signal`) => `AsyncIterable`\<`T`\>; \} | Supervision inputs. |
| `options.onError` | (`error`) => `void` | Invoked at most once, with the thrown value unchanged, when the source faults while the signal is NOT aborted. It carries the caller's entire fault policy (logging, wording, recovery), which is why the primitive itself stays logging-free. A throw from `onError` propagates to the consumer. |
| `options.signal` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | The signal the stream is bound to. Its aborted state is the single source of truth for "did we cause this throw?": aborted means swallow, not aborted means surface. |
| `options.source` | (`signal`) => `AsyncIterable`\<`T`\> | Builds the async iterable to supervise, receiving the bound [AbortSignal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) so it can wire cancellation into whatever it reads. It is not invoked at all when the signal is already aborted. |

#### Returns

`AsyncGenerator`\<`T`, `void`, `undefined`\>

An async generator yielding the source's values in order, completing when the source completes, when the signal aborts, or once a fault has been delivered
         to `onError`.

#### Example

```ts
import { loopFaultReporter, superviseStream } from "homebridge-plugin-utils";

// A supervised poll whose values feed both HomeKit and MQTT. Tearing down `this.signal` ends the loop silently; any other failure is reported once and the stream
// ends, so this `for await` never has to catch.
for await (const reading of superviseStream({

  onError: loopFaultReporter(this.log, "sensor"),
  signal: this.signal,
  source: (signal) => this.poll(signal)
})) {

  this.updateHomeKit(reading);
  this.publishMqtt(reading);
}
```

***

### takeLast()

```ts
function takeLast<T>(source, n): Promise<T[]>;
```

Drain an async iterable and retain only its last `n` values, returned in original (oldest-to-newest) order.

The implementation is a true fixed-capacity ring buffer: it allocates a single backing array of length `n` once and overwrites slots modulo `n` as values arrive, so
memory stays bounded at `n` entries no matter how long the source runs. It deliberately does NOT accumulate every value and slice the tail at the end - that naive
shape would grow without bound on a long-running source (the canonical use here is "the last ~500 lines of a multi-MB log seed"), defeating the entire point of a
bounded retainer. When the source yields `n` or fewer values the result is simply those values in order; when it yields more, only the most recent `n` survive.

Consumption is eager and complete: the source is iterated to exhaustion before returning, so callers must only pass iterables that terminate (a finite seed window,
not an unbounded live stream). A non-positive `n` retains nothing and returns an empty array without iterating the source at all.

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| `T` | The element type of the source. |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `source` | `AsyncIterable`\<`T`\> | The async iterable to drain. Must terminate. |
| `n` | `number` | The maximum number of trailing values to retain. Values `<= 0` retain nothing. |

#### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`T`[]\>

The last `n` values produced by `source`, in original order.

#### Example

```ts
import { takeLast } from "homebridge-plugin-utils";

// Retain only the most recent 500 seed lines from a bounded history window, regardless of how many the source emits.
const recent = await takeLast(seedLines, 500);
```

***

### toStartCase()

```ts
function toStartCase(input): string;
```

Start case a string, capitalizing the first letter of each word unconditionally. A word opens at the start of the string or after a run of whitespace, and its
opening character is capitalized when it is a letter in any script - Latin, Cyrillic, Greek and the rest alike - matched as a whole code point, so a letter
outside the Basic Multilingual Plane cases correctly rather than as half a surrogate pair. A word opening with a digit or with punctuation is left as it
stands, and a script that carries no case, such as Chinese or Japanese, passes through unchanged.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `input` | `string` | The string to start case. |

#### Returns

`string`

Returns the start cased string.

#### Example

```ts
toStartCase("this is a test");
toStartCase("élan vital");
```

Returns: `This Is A Test` and `Élan Vital`.

***

### validateName()

```ts
function validateName(name): boolean;
```

Validate an accessory name according to HomeKit naming conventions.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `name` | `string` | The name to validate. |

#### Returns

`boolean`

Returns `true` if the name passes HomeKit's naming rules, `false` otherwise.

#### Remarks

This validates names using [HomeKit's naming rulesets](https://developer.apple.com/design/human-interface-guidelines/homekit#Help-people-choose-useful-names)
and HAP specification documentation:

- Starts and ends with a letter or number. Exception: may end with a period.
- May not have multiple spaces adjacent to each other, nor begin nor end with a space.
- May have the following special characters: -"',.#&.
- Must not include emojis.

#### Example

```ts
validateName("Test|Switch")
```

Returns: `false`.

***

### waitWithSignal()

```ts
function waitWithSignal<T>(promise, signal): Promise<T>;
```

Wait for `promise` to settle, bailing out early if `signal` aborts while it is still pending.

The canonical primitive for "observe this promise but let a caller cancel the wait." Useful inside async flows that reference an external promise (e.g., a resource
class's internal state) and need to honor a per-call abort signal without modifying the underlying promise. Whichever settles first wins: `promise` resolves or
rejects normally, or the signal aborts and `waitWithSignal` rejects with `signal.reason`. The rule underneath is the platform's own - an abort cancels pending work
and never un-does completed work - so the signal ends only a wait that is still waiting: a promise that has already settled when the call is made is delivered as
it settled, fulfilled or rejected, even under a signal that has already aborted, and a promise still pending at the call, one that settles a microtask later
included, is ended by a signal that has already aborted.

The abort listener is attached with `{ once: true }` and explicitly removed when the helper settles, so there is no listener leak regardless of which side wins the
race. `promise` is ALWAYS observed via `.then(resolve, reject)` - whether or not the signal has already aborted - which means attaching `waitWithSignal` to a promise
marks it as handled for Node's unhandled-rejection tracker. Callers do not need to wrap `promise` in [markHandled](mark-handled.md#markhandled) separately.

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| `T` | The resolved value type of `promise`. |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `promise` | [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`T`\> | The promise to wait on. |
| `signal` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | The abort signal whose firing interrupts the wait. |

#### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`T`\>

The promise's resolved value.

#### Throws

`signal.reason` if the signal aborts while `promise` is still pending, or the original rejection if `promise` rejects first.

#### Example

```ts
import { waitWithSignal } from "homebridge-plugin-utils";

try {

  const initSegment = await waitWithSignal(assembler.initSegment, callerSignal);
} catch {

  // Caller aborted, or the assembler rejected init. Either way, unwind cleanly.
  return;
}
```

## Other

### formatBps

Re-exports [formatBps](formatters.md#formatbps)

***

### formatBytes

Re-exports [formatBytes](formatters.md#formatbytes)

***

### formatMs

Re-exports [formatMs](formatters.md#formatms)

***

### formatPercent

Re-exports [formatPercent](formatters.md#formatpercent)

***

### formatSeconds

Re-exports [formatSeconds](formatters.md#formatseconds)

***

### markHandled

Re-exports [markHandled](mark-handled.md#markhandled)
