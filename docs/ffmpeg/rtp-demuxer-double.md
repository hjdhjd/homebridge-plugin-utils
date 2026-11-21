[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / ffmpeg/rtp-demuxer-double

# ffmpeg/rtp-demuxer-double

A socket-free [RtpDemuxerHandle](rtp.md#rtpdemuxerhandle) test double.

A class that stands up a two-way audio path has its hard cases in the order a demuxer's events arrive: a session already torn down when it builds the demuxer, a
bind that fails, a session torn down while it waits for the first media packet. This module ships the double for those - a [TestRtpDemuxer](#testrtpdemuxer) a test drives one
event at a time, with no socket anywhere in sight - and a [TestRtpDemuxerFactory](#testrtpdemuxerfactory) that builds one per `create` from the init the consumer passed and records
that init, so a suite reads the ports the consumer chose from the recorded init.

The double binds and settles as the real demuxer does: its bind completes or fails inside its constructor, from the answer a suite scripts, `ready` and
`mediaReady` are marked handled and reject with the lifetime's reason when the lifetime ends while they are pending, inside the constructor when the bind fails or
the parent signal has already aborted, and a promise that has resolved stays resolved. The levers refuse an event no real demuxer produces rather than modeling it,
and a construction asked for an input port no UDP socket can hold throws the real demuxer's own `RangeError`, through the port rule the two share.

Signatures come from the demuxer's own exported types, imported for their types alone, so a member here cannot drift from the contract it stands in for without the
compiler saying so, and loading the double loads none of the demuxer's socket machinery.

## Testing

### TestRtpDemuxer

A socket-free [RtpDemuxerHandle](rtp.md#rtpdemuxerhandle) double: its bind completes or fails inside its constructor as a suite scripts it, and its first RTP packet arrives and its
socket fails when a test says so.

The lifetime is the parent signal the constructor receives composed with the double's own. The parent aborting ends it with the parent's reason, `abort()` ends it
with the reason it is handed or with `HbpuAbortError("shutdown")` when that reason is `undefined` or `null`, and a refused bind or a socket failure ends it as
`"failed"` with the socket's error as its cause; whichever comes first stands. `aborted` and `isTimedOut` are read from the lifetime as the real demuxer reads them.

The bind happens inside the constructor, as the real demuxer's does, so when construction returns the double is in a state its subject can be in. Under a parent
signal already aborted nothing binds, as the real demuxer returns before its bind: the answer goes unread, `ready` and `mediaReady` have rejected with the
parent's reason and `inputPort` reads the requested port. Otherwise a scripted port completes the bind on it, so `ready` has resolved and `inputPort` reads that
port, kept after the lifetime ends. A scripted `"refused"` fails the bind, the lifetime ending as `"failed"` with the refused bind's error as its cause, and with
no answer a specific-port construction binds its own port.

Where it differs from the real demuxer:

- It has no socket, so nothing is forwarded and no heartbeat runs.
- It has no inactivity watchdog and reads no clock, so a suite stands in for the lapse with `abort(new HbpuAbortError("timeout"))`, which `isTimedOut` reads as
  the real demuxer's does.
- It logs nothing.
- Its disposal has no port to wait for, so it resolves once it has aborted.

#### Example

```ts
import { TestRtpDemuxerFactory, expectAt } from "homebridge-plugin-utils/testing";

// The session's ephemeral bind completes on the port the script names, inside the demuxer's construction, as the kernel's would.
const factory = new TestRtpDemuxerFactory([50000]);
const session = new TalkbackSession({ demuxerFactory: factory, signal: controller.signal });
const { demuxer, init } = expectAt(factory.createCalls, 0, "the demuxer the session built");

// The port the session asked for and the port it was bound to, read without binding anything, then the session's wait for inbound media, exercised with no
// socket at all.
assert.equal(init.inputPort, 0);
assert.equal(demuxer.inputPort, 50000);
demuxer.resolveMediaReady();
```

#### See

TestRtpDemuxerFactory

#### Implements

- [`RtpDemuxerHandle`](rtp.md#rtpdemuxerhandle)

#### Constructors

##### Constructor

```ts
new TestRtpDemuxer(init, bind?): TestRtpDemuxer;
```

Construct a double and settle its bind, as the real demuxer's constructor does.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `init` | `Pick`\<[`RtpDemuxerInit`](rtp.md#rtpdemuxerinit), `"inputPort"` \| `"signal"`\> | The members of a consumer's [RtpDemuxerInit](rtp.md#rtpdemuxerinit) the double reads. |
| `bind?` | [`TestSocketBind`](rtp-probe-socket-double.md#testsocketbind) | Optional. What the bind answers: the port it completes on, from 1 to 65535 and a specific-port construction's own port, or `"refused"` for a bind the kernel rejects. With no answer, a specific-port construction binds its own port. Unread under a parent signal already aborted, since nothing binds then. |

###### Returns

[`TestRtpDemuxer`](#testrtpdemuxer)

###### Throws

The real demuxer's `RangeError` when `init.inputPort` is not a whole number from 0 to 65535, ahead of everything else. An `Error` when a
        construction that binds is handed a port that is not a whole number from 1 to 65535, when a specific-port construction is handed another port, and
        when an ephemeral construction is handed no answer, since only a suite can name the port a kernel would assign.

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="mediaready"></a> `mediaReady` | `public readonly` | [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\> | Resolves when [TestRtpDemuxer.resolveMediaReady](#resolvemediaready) is pulled, and rejects with the lifetime's reason when the lifetime ends while it is pending. Marked handled, as the real demuxer's is. |
| <a id="ready"></a> `ready` | `public readonly` | [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\> | Carries the bind's outcome, settled inside the constructor: resolved when the bind completed, and rejected with the lifetime's reason when the bind was refused or the parent signal had already aborted. Marked handled, as the real demuxer's is. |
| <a id="signal"></a> `signal` | `public readonly` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | The abort signal representing this double's lifetime, composed from the parent signal the constructor received and this double's own, as the real demuxer composes its parent with its own. |

#### Accessors

##### aborted

###### Get Signature

```ts
get aborted(): boolean;
```

`true` once the lifetime has ended. Derived from the signal, as the real demuxer's is.

###### Returns

`boolean`

`true` once the lifetime has ended. Derived from `signal`.

###### Implementation of

[`RtpDemuxerHandle`](rtp.md#rtpdemuxerhandle).[`aborted`](rtp.md#aborted-1)

##### inputPort

###### Get Signature

```ts
get inputPort(): number;
```

The port the bind completed on from the moment construction returns, kept after the lifetime ends, and the requested port when the bind was refused or the
parent signal had already aborted.

###### Returns

`number`

The UDP port the demuxer is bound to. The bind has completed or failed by the time construction returns, so this reads the port the kernel bound from then on,
an ephemeral construction's (`inputPort: 0`) among them, and the requested port when the bind failed or the lifetime ended before it.

###### Implementation of

[`RtpDemuxerHandle`](rtp.md#rtpdemuxerhandle).[`inputPort`](rtp.md#inputport-1)

##### isTimedOut

###### Get Signature

```ts
get isTimedOut(): boolean;
```

`true` when the lifetime's reason is a timeout, read through the same rule the real demuxer reads it by.

###### Returns

`boolean`

`true` when the lifetime ended for a timeout: `HbpuAbortError("timeout")`, which the inactivity watchdog raises, or the platform `TimeoutError`.

###### Implementation of

[`RtpDemuxerHandle`](rtp.md#rtpdemuxerhandle).[`isTimedOut`](rtp.md#istimedout-1)

#### Methods

##### \[asyncDispose\]()

```ts
[asyncDispose](): Promise<void>;
```

Abort with `HbpuAbortError("shutdown")` unless the lifetime has already ended, and resolve. Safe to call more than once and after the lifetime's end.

###### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`void`\>

A promise that resolves once the double has aborted.

###### Implementation of

[`RtpDemuxerHandle`](rtp.md#rtpdemuxerhandle).[`[asyncDispose]`](rtp.md#asyncdispose-2)

##### abort()

```ts
abort(reason?): void;
```

End the lifetime, as the real demuxer's `abort()` does: with `reason`, or with `HbpuAbortError("shutdown")` when it is `undefined` or `null`. A call once the
lifetime has ended changes nothing.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `reason?` | `unknown` | Optional abort reason. |

###### Returns

`void`

###### Implementation of

[`RtpDemuxerHandle`](rtp.md#rtpdemuxerhandle).[`abort`](rtp.md#abort-1)

##### failSocket()

```ts
failSocket(cause): void;
```

Fail the socket after the bind, as a socket error does on the real demuxer: the lifetime ends with `HbpuAbortError("failed")` carrying `cause`, and a pending
`mediaReady` rejects with it. A bind that fails is scripted as `"refused"` at construction instead. Once the lifetime has ended the call changes nothing, as the
real demuxer passes over a socket error during its teardown.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `cause` | `Error` | The error the socket raised. |

###### Returns

`void`

##### resolveMediaReady()

```ts
resolveMediaReady(): void;
```

Resolve `mediaReady`, as the real demuxer's first forwarded RTP packet does.

###### Returns

`void`

###### Throws

The lifetime's reason once the lifetime has ended, a refused bind's among them, and an `Error` once `mediaReady` has resolved.

***

### TestRtpDemuxerFactory

An [RtpDemuxerFactory](rtp.md#rtpdemuxerfactory) double that records every `create` call and answers a fresh [TestRtpDemuxer](#testrtpdemuxer) over the init the consumer passed: the init's
`signal` is the double's parent signal, so the consumer's own signal ends the demuxer it gets back as it ends a real one, and the init's `inputPort` is the port the
double asks its bind for. A test reads the recorded init for the ports the consumer chose and the recorded demuxer to drive it.

The factory holds a script of binds and hands each construction that binds its next answer, a specific-port construction's among them, so one script
interleaves every demuxer a consumer builds, in the order it builds them. An answer is spent when it is handed out, a construction under a signal already
aborted binds nothing and takes none, and once the script is spent each construction builds as an unscripted one does. A construction the double refuses, an
ephemeral one with no answer among them, throws from `create` and is not recorded. The throw reaches the consumer's own error handling around `create`, so a
suite that scripts too few binds reads it there as a failure the consumer handles, and its message names what the script lacked.

#### See

 - RtpDemuxerFactory
 - TestRtpDemuxer

#### Implements

- [`RtpDemuxerFactory`](rtp.md#rtpdemuxerfactory)

#### Constructors

##### Constructor

```ts
new TestRtpDemuxerFactory(script?): TestRtpDemuxerFactory;
```

Construct a factory.

###### Parameters

| Parameter | Type | Default value | Description |
| ------ | ------ | ------ | ------ |
| `script?` | readonly [`TestSocketBind`](rtp-probe-socket-double.md#testsocketbind)[] | `[]` | Optional. What each construction that binds answers, in the order the constructions are made: the port its bind completes on, or `"refused"`. Defaults to none, so each specific-port construction binds its own port. |

###### Returns

[`TestRtpDemuxerFactory`](#testrtpdemuxerfactory)

#### Properties

| Property | Modifier | Type | Default value | Description |
| ------ | ------ | ------ | ------ | ------ |
| <a id="createcalls"></a> `createCalls` | `public readonly` | \{ `demuxer`: [`TestRtpDemuxer`](#testrtpdemuxer); `init`: [`RtpDemuxerInit`](rtp.md#rtpdemuxerinit); \}[] | `[]` | Every create call's init and the demuxer it answered, in order, so a test can assert the boundary was reached with what it expected and can drive the demuxer that came back. A call whose construction threw is not recorded. |

#### Methods

##### create()

```ts
create(init): RtpDemuxerHandle;
```

Record the create call and answer a fresh double over the init's port and signal, its bind settled from the script's next answer.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `init` | [`RtpDemuxerInit`](rtp.md#rtpdemuxerinit) | The init the consumer passed. |

###### Returns

[`RtpDemuxerHandle`](rtp.md#rtpdemuxerhandle)

The demuxer double.

###### Throws

The real demuxer's `RangeError` when `init.inputPort` is not a whole number from 0 to 65535, and an `Error` when the double refuses the construction, as
        [TestRtpDemuxer](#testrtpdemuxer) states. Each reaches the consumer's own error handling.

###### Implementation of

[`RtpDemuxerFactory`](rtp.md#rtpdemuxerfactory).[`create`](rtp.md#create)
