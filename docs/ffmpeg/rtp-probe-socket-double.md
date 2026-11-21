[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / ffmpeg/rtp-probe-socket-double

# ffmpeg/rtp-probe-socket-double

A socket-free probe-socket test double for the RTP port allocator.

[RtpPortAllocator](rtp.md#rtpportallocator) reaches its probe sockets through an [RtpProbeSocketFactory](rtp.md#rtpprobesocketfactory), which is what lets this double stand
where the package's own sockets would: every bind answers what the suite scripted, so a refused bind, a collision with a port the pool already holds, a spent
attempt budget and an abort while a bind is pending are each set up directly rather than waited for on a crowded host. This module ships a
[TestProbeSocketFactory](#testprobesocketfactory) that answers each bind from its script and records the port every bind asked for, so a suite reads the allocator's probing back
in order, and the error a refused bind answers, built here once for every socket double the package ships.

Signatures come from the allocator's own exported types, imported for their types alone, and the module imports nothing from the testing entry point that
re-exports it, so loading the double loads neither a socket nor the entry point.

## Testing

### TestProbeSocketFactory

A socket-free [RtpProbeSocketFactory](rtp.md#rtpprobesocketfactory) double: each socket it makes answers its bind from a script, and the factory records the port every bind asked for.

Each bind is answered inside `bind`, as a socket from the package's own factory answers a bind to an address literal, so an allocator over the double settles as
it does over its default sockets. Built with `deferred`, the double answers each bind on a later turn of the event loop instead, the timing of a substitute
that waits on a resolver, which an [RtpProbeSocketFactory](rtp.md#rtpprobesocketfactory) may hand the allocator, and the one timing in which an abort can land while a bind is pending.
The answer waits a whole turn rather than a tick, so the cleanup an abort queues has run by the time it arrives, wherever the reservation and its abort were
called from. A socket closed while its bind is pending emits nothing when the answer arrives, as a real socket closed before its bind completes emits nothing.

Where it differs from the package's own sockets:

- It binds nothing, so a granted bind holds no port and the collisions a crowded host would report are the ones the script names.
- It reads no address family: every socket reports the IPv4 any-address, and a refused bind's error names it, whatever family the allocator asked for.
- A script that runs short, or that answers a bind with a port no kernel would grant, one that is not a whole number from 1 to 65535 or another than a
  specific bind asked for, leaves that bind unanswered and throws an `Error` naming it on a later tick, whatever the timing, which surfaces on Node's
  uncaught-exception channel and fails the running test, while the reservation waiting on the bind never settles. A throw inside `bind` would reach the
  allocator as a refused port and pass for contention.

#### Example

```ts
import { TestProbeSocketFactory } from "homebridge-plugin-utils/testing";

// The first bind is refused, so the allocator's retry reserves the port the second bind is granted.
const probes = new TestProbeSocketFactory([ "refused", 50000 ]);
const allocator = new RtpPortAllocator({ socketFactory: probes.create });

await using reservation = await allocator.reserve();

assert.equal(reservation.port, 50000);
assert.deepEqual(probes.binds, [ 0, 0 ]);
```

#### Constructors

##### Constructor

```ts
new TestProbeSocketFactory(script, options?): TestProbeSocketFactory;
```

Construct a factory.

###### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `script` | readonly [`TestSocketBind`](#testsocketbind)[] | What each bind answers, in the order the binds are made. A suite scripts exactly the binds it expects, and a bind past the end, or one answered with a port no kernel would grant, throws on a later tick rather than being answered. |
| `options?` | \{ `deferred?`: `boolean`; \} | Optional options. |
| `options.deferred?` | `boolean` | Answer each bind on a later turn of the event loop rather than inside `bind`, as a substitute socket that waits on a resolver does. Defaults to `false`. |

###### Returns

[`TestProbeSocketFactory`](#testprobesocketfactory)

#### Properties

| Property | Modifier | Type | Default value | Description |
| ------ | ------ | ------ | ------ | ------ |
| <a id="binds"></a> `binds` | `public readonly` | `number`[] | `[]` | The port each bind asked for, in the order the binds were made: `0` for a random port, and the port itself for a specific one. |
| <a id="create"></a> `create` | `public readonly` | [`RtpProbeSocketFactory`](rtp.md#rtpprobesocketfactory) | `...` | The factory function this double exposes, bound as a property so it is handed straight to the allocator's `socketFactory` without losing `this`. The address family it is asked for goes unread. |

***

### TestSocketBind

```ts
type TestSocketBind = number | "refused";
```

What one scripted bind answers: the port the socket is bound to, or `"refused"` for a bind the kernel rejects because the port is taken. A bind to a specific
port is scripted with that same port, since a kernel that grants a specific bind grants exactly the port asked for, and a socket double refuses a port no
kernel would grant.
