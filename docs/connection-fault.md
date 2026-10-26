[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / connection-fault

# connection-fault

The one level a connection fault is logged at, read from its transport classification and whether the fault ended a long-lived connection that had been working.

The family logs a connection fault by one rule: error when the operator must act, warning when the fault heals itself, and quiet for a teardown and for the way a
working long-lived connection ordinarily ends. Every library that talks to a device over the network meets the same faults through the same classifier, so the
network part of that rule is written once, here, and the same fault reads at the same level in every plugin that met it, rather than at whatever level each copy
of the rule drifted to. A library keeps only the cases its own protocol knows about above the table, and states them before it asks.

The table, by the kind [classifyTransportError](transport-error.md#classifytransporterror) answers and by whether the fault ended a long-lived connection that
had been working, which a caller passes as `open`:

| Kind | `true`, a working long-lived connection | `false`, a connection being dialed or a one-shot request |
|------|------|---------|
| `aborted`, `destroyed` | quiet | quiet |
| `certificate`; `dns` with `ENOTFOUND` | error | error |
| `dns` with `EAI_AGAIN`; `refused`; `unreachable`; `connect-timeout`; `reset`; `retries-exhausted`; `transport` with a code | warning | warning |
| `timeout` | quiet | warning |
| `transport` with no code | quiet | warning |

A teardown is no fault, so it is quiet in every column. A certificate nothing trusts and a host name that does not resolve stay broken until someone changes
something, so they are errors. Everything that heals itself is a warning, a code the table names no row for among them, so a new code is reported rather than
silenced. The rows that read `open` are the ways a working long-lived connection ordinarily ends, a timeout and a hang-up, which stay quiet there, while a dial
or a one-shot request that ends in one of them went unanswered, which is a warning.

Open means the fault ended a long-lived connection that had been working, a WebSocket or a stream past its upgrade, and dialing means the connection was still
being dialed, its TCP, TLS or upgrade handshake under way. A one-shot HTTP request passes `open` as `false` whatever socket undici gave it, so its timeouts and its
codeless failures log as warnings. The codeless `transport` row speaks for undici's empty WebSocket `TypeError`, which an open WebSocket raises when the peer hangs
up without a close frame, and which a refused upgrade raises while dialing. A consumer's own error types carry no code of their own, so a clean close, a stall, an
HTTP status and a refused sign-in all classify into that row, and each is the consumer's to decide above the table.

## Utilities

### ConnectionFaultLevel

```ts
type ConnectionFaultLevel = "error" | "quiet" | "warning";
```

The level [connectionFaultLevel](#connectionfaultlevel-1) answers: `error` when the operator must act, `warning` when the fault heals itself, and `quiet` when it is no fault worth a
user's attention, such as a teardown.

***

### connectionFaultLevel()

```ts
function connectionFaultLevel(failure, options): ConnectionFaultLevel;
```

Answer the level a connection fault is logged at, from its transport classification and whether the fault ended a long-lived connection that had been working,
by the table this module states.

Pure: no state, no clock and no logging. The `switch` over the kind is exhaustive, so a kind the classifier learns fails the build here until the table places it.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `failure` | [`TransportFailure`](transport-error.md#transportfailure) | The classified failure, as [classifyTransportError](transport-error.md#classifytransporterror) answered it. |
| `options` | \{ `open`: `boolean`; \} | Which of the table's columns the fault falls in. |
| `options.open` | `boolean` | Whether the fault ended a long-lived connection that had been working: `true` for a WebSocket or a stream past its upgrade, `false` while the connection was still being dialed. A one-shot HTTP request passes `false` whatever socket undici gave it, so its timeouts and codeless failures log as warnings. |

#### Returns

[`ConnectionFaultLevel`](#connectionfaultlevel)

The level to log the fault at.

#### Example

```ts
import { classifyTransportError, connectionFaultLevel } from "homebridge-plugin-utils";

const failure = classifyTransportError(error, this.signal);

// A long-lived stream hands in whether it had been working, which decides the level of a timeout and of a hang-up, while a one-shot HTTP request passes `false`.
switch(connectionFaultLevel(failure, { open: this.streaming })) {

  case "error": {

    this.log.error("The controller connection failed.", { code: failure.code, kind: failure.kind });

    break;
  }

  case "warning": {

    this.log.warn("The controller connection failed; retrying.", { code: failure.code, kind: failure.kind });

    break;
  }

  case "quiet": {

    this.log.debug("The controller connection ended.", { code: failure.code, kind: failure.kind });

    break;
  }
}
```
