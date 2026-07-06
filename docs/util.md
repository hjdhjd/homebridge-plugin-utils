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
| <a id="name"></a> `name` | `readonly` | [`HbpuAbortReason`](#hbpuabortreason) | The discriminator. Matches one of [HbpuAbortReason](#hbpuabortreason). | `Error.name` |

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
occur. This is the contract `using watchdog = new Watchdog(...)` relies on - the resource is dead when the block exits, not merely quiescent. Idempotent; repeated
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
when no arm is pending - the method is idempotent.

###### Returns

`void`

***

### HbpuAbortErrorOptions

Options accepted by [HbpuAbortError](#hbpuaborterror)'s constructor.

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="cause"></a> `cause?` | `unknown` | The underlying cause of the abort. For `"failed"` reasons this is typically the upstream error. For `"failed"` exits from child processes, this is idiomatically a structured object carrying diagnostic context (e.g., `{ exitCode, exitSignal }`) - specialized subclasses may tighten this later. |
| <a id="message"></a> `message?` | `string` | Optional human-readable message. When omitted, the error's `message` defaults to the reason name, which is sufficient for discrimination-based handling. |

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

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="debug"></a> `debug` | (`message`, ...`parameters`) => `void` | Logs a debug-level message. |
| <a id="error"></a> `error` | (`message`, ...`parameters`) => `void` | Logs an error-level message. |
| <a id="info"></a> `info` | (`message`, ...`parameters`) => `void` | Logs an info-level message. |
| <a id="warn"></a> `warn` | (`message`, ...`parameters`) => `void` | Logs a warning-level message. |

***

### RetryOptions

Options accepted by [retry](#retry).

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="attempts"></a> `attempts?` | `number` | Total number of attempts, including the first. Must be >= 1. Defaults to 3. Values less than 1 throw synchronously (rejected promise) at the top of `retry()`. Pass `Infinity` for unbounded attempts - the loop then terminates only on success, an abort, or a `shouldRetry` veto, never on an exhausted budget. |
| <a id="backoff"></a> `backoff?` | (`attempt`) => `number` | Backoff policy, invoked with the attempt number (1-indexed) about to be run. The returned value is the delay in milliseconds before running that attempt. Called only between attempts (i.e., never with `attempt === 1`). Defaults to [defaultRetryBackoff](#defaultretrybackoff) (exponential with a 30-second ceiling). |
| <a id="shouldretry"></a> `shouldRetry?` | (`error`, `attemptNumber`) => `boolean` | Optional predicate consulted after an attempt throws and attempts remain. Receives the rejected error and the 1-indexed number of the attempt that just failed; return `false` to stop immediately and rethrow that error (no backoff wait, no further attempts), or `true` to retry per the backoff policy. When omitted, every error is retried until `attempts` is exhausted - the existing behavior, unchanged. This is the seam that lets a caller retry some failures and fail fast on others (e.g. retry network faults but give up on an authentication error) without owning the attempt loop itself. |
| <a id="signal"></a> `signal?` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | Optional abort signal. Aborting cancels any in-flight backoff wait and is forwarded verbatim to `operation` as its own signal argument, so well-behaved operations cancel too. An abort at any point - mid-attempt, mid-backoff, or before the first attempt - rejects the outer promise with the signal's reason. |

***

### WatchdogInit

Construction-time options for [Watchdog](#watchdog).

#### Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="onfire"></a> `onFire` | () => `void` | Callback invoked when the watchdog window lapses without a re-arm. Typically aborts an owning controller (`() => this.#controller.abort(new HbpuAbortError("timeout"))`) but the watchdog itself is agnostic about what the fire does. Runs only when the observed signal has not already aborted; if the signal fires before the timer, `onFire` is skipped entirely. |
| <a id="signal-1"></a> `signal` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | The lifetime signal the watchdog observes. When the signal aborts for any reason the pending timer is cleared and no further arms take effect. Typically the consumer's composed lifetime signal (`this.signal`) so both parent-initiated and internal aborts wind the watchdog down. |
| <a id="timeoutms"></a> `timeoutMs` | `number` | Inactivity window in milliseconds. The first `arm()` schedules a fire at now + `timeoutMs`; each subsequent `arm()` restarts the clock. |

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

### HbpuAbortReason

```ts
type HbpuAbortReason = "closed" | "failed" | "replaced" | "shutdown" | "timeout";
```

The canonical set of abort reasons used across `homebridge-plugin-utils`.

Every long-lived resource class in the library exposes an [AbortSignal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) whose abort reason is normally an [HbpuAbortError](#hbpuaborterror) carrying one of these names.
Consumers discriminate on the `.name` field. Platform errors produced by `AbortSignal.timeout()` and bare `controller.abort()` interoperate by matching names:
`TimeoutError` and `AbortError` from the platform both flow through the same discrimination paths unchanged.

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

### RunWithAbortOptions

```ts
type RunWithAbortOptions = 
  | {
  signal: AbortSignal;
  timeout?: number;
}
  | {
  timeout: number;
};
```

Options for [runWithAbort](#runwithabort). At least one of `signal` or `timeout` must be provided so there is always an abort mechanism. TypeScript enforces this at compile
time through a discriminated union - the "no abort mechanism" case is unrepresentable.

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
const composed = composeSignals(init.signal, AbortSignal.timeout(PROBE_DEFAULT_TIMEOUT_MS));
```

***

### defaultRetryBackoff()

```ts
function defaultRetryBackoff(attempt): number;
```

The default backoff policy used by [retry](#retry): exponential with a 30-second ceiling, starting at 1 second for the second attempt (`attempt = 2`).

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `attempt` | `number` | The attempt number about to be run (1-indexed; never called with `attempt === 1`, since the first attempt runs immediately). |

#### Returns

`number`

The delay, in milliseconds, to wait before executing `attempt`.

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

### isHbpuAbortError()

```ts
function isHbpuAbortError(error): error is HbpuAbortError;
```

Type guard: returns `true` if `error` is an [HbpuAbortError](#hbpuaborterror).

Use this to discriminate HBPU's canonical abort errors from arbitrary thrown values, without nesting `instanceof` checks.

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
throughout consuming code. The generic parameter `R` preserves the specific reason string in the narrowed type so callers that discriminate further by name get the
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
([Watchdog](#watchdog), the inactivity monitors on `FfmpegProcess` / `RtpDemuxer` / `Mp4SegmentAssembler`) - and the platform [DOMException](https://developer.mozilla.org/en-US/docs/Web/API/DOMException)/`Error` whose
`.name === "TimeoutError"` - produced by `AbortSignal.timeout()`. Consumers discriminate on a single predicate regardless of which code path originated the timeout.

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

### markHandled()

```ts
function markHandled<T>(promise): Promise<T>;
```

Attach a shared no-op rejection handler to `promise` so that if it rejects and no other observer is attached, Node does not emit an `UnhandledPromiseRejection`
warning. Returns the original promise so callers can mark-and-assign in one expression.

Use this on internal promise handles (`ready`, `exited`, init segments) that a class exposes for callers who may or may not choose to observe them. Callers who
`await` the promise or attach their own `.catch` still see the rejection through their own chain - this helper only marks the promise as observed for Node's
unhandled-rejection tracker.

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| `T` | The resolved value type. |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `promise` | [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`T`\> | The promise to mark handled. |

#### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`T`\>

The same promise, for chained assignment.

#### Example

```ts
this.ready = markHandled(readyResolvers.promise);
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

Returning a `Disposable` serves two patterns through one primitive:

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

  // `return await promise` (not a bare `return promise`) is load-bearing inside an async function. `using` disposes when the enclosing function body finishes
  // executing, and without an `await` the body finishes synchronously at the `return` statement - even though the returned promise is still pending. The
  // listener would therefore be removed the instant the function returned, well before the promise settles. Adding `await` creates a suspension point that
  // keeps the `using` scope alive until the promise actually settles, which is what the "scope-bound registration" pattern relies on.
  return await promise;
}
```

***

### retry()

```ts
function retry<T>(operation, options?): Promise<T>;
```

Retry an async operation with configurable attempts and backoff, with first-class abort signal support.

The operation receives the caller's [AbortSignal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) directly (or a permanent never-aborted sentinel when no caller signal was provided). Well-behaved operations
forward this signal to any cancellation-aware API they call (`fetch`, `events.once`, etc.) so the in-flight attempt actually cancels. Between-attempt waits use
`node:timers/promises` `setTimeout` with the signal, so abort also interrupts the backoff.

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
  backoff: (attempt) => 1_000 * attempt,
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
| `options` | [`RunWithAbortOptions`](#runwithabortoptions) | Abort options. Provide `timeout` (milliseconds), an external `signal`, or both. |

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

Resilient background loops - membership observers, reachability probes, telemetry firehoses - all share one subtle, correctness-critical invariant: a throw is a
*fault* only when we did not cause it. When the bound signal is aborted, a throw is the orderly unwinding of a loop the caller already tore down, so it is swallowed
silently. Any other throw is a genuine fault and is handed to `onError` exactly once. Hand-copying that swallow-on-abort-versus-surface-once discrimination across
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

Start case a string, capitalizing the first letter of each word unconditionally.

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
```

Returns: `This Is A Test`.

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

Wait for `promise` to settle, bailing out early if `signal` aborts before it does.

The canonical primitive for "observe this promise but let a caller cancel the wait." Useful inside async flows that reference an external promise (e.g., a resource
class's internal state) and need to honor a per-call abort signal without modifying the underlying promise. Whichever settles first wins: `promise` resolves/rejects
normally, or the signal aborts and `waitWithSignal` rejects with `signal.reason` - including when the signal was already aborted at call time.

The abort listener is attached with `{ once: true }` and explicitly removed when the helper settles, so there is no listener leak regardless of which side wins the
race. `promise` is ALWAYS observed via `.then(resolve, reject)` - including on the pre-aborted-signal path - which means attaching `waitWithSignal` to a promise
marks it as handled for Node's unhandled-rejection tracker. Callers do not need to wrap `promise` in [markHandled](#markhandled) separately.

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

`signal.reason` if the signal aborts before `promise` settles, or the original rejection if `promise` rejects first.

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
