[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / transport-error

# transport-error

One kind-tagged reading of whatever a transport threw.

A plugin talking to a cloud API or a local gateway has to answer the same question before it can log, wrap, or retry anything: what kind of failure was that? The
raw material is unhelpful. A connection fault arrives as an errno string sitting on an error several `cause` links below the one that was caught. A deadline arrives
as a platform `TimeoutError` whose only marker is its `name`. A shutdown arrives as an `AbortError` that is shaped exactly like a deadline. A transport that gave up
retrying arrives as a code of its own. Working that out is the same walk, the same name checks, and the same code map every time, and each hand-written copy of it
drifts from the others.

This module owns that derivation and stops there. It answers what kind of failure occurred; it does not decide what that means. Which failures are worth retrying,
which deserve a warning rather than a debug line, and how any of it is phrased to a user all stay with the caller, because they belong to a protocol this module
knows nothing about.

The precedence is fixed, and each step exists because the step below it cannot tell the case apart:

1. The lifetime signal, if it has aborted. A teardown reads as a teardown whatever the rejection looked like.
2. A timeout shape anywhere in the cause chain.
3. A remaining cancellation shape, which belongs to the per-request deadline once the lifetime signal is ruled out.
4. The transport and errno codes, mapped to their kinds.
5. Everything else, which is a real failure carrying no marker anyone can read.

Composing with it. It reads exactly ONE signal, so pass the lifetime signal you compose into your requests; a caller that composes further
cancellation sources beyond a lifetime bound and a per-request deadline ranks those itself before calling here. And the record it returns is a classification, never
something to throw: a caller's own error or fault type owns any wrap-and-rethrow it wants, including passing an already-classified failure straight through.

## Utilities

### TransportFailure

```ts
type TransportFailure = 
  | {
  cause: unknown;
  code: string;
  kind:   | "connect-timeout"
     | "destroyed"
     | "dns"
     | "refused"
     | "reset"
     | "retries-exhausted";
}
  | {
  cause: unknown;
  code?: string;
  kind: "aborted" | "timeout" | "transport";
};
```

A classified transport failure: `kind` is the taxonomy answer, `cause` is the thrown value verbatim, and `code` is the transport or errno code the cause chain
carried, when it carried one.

Splitting this into a discriminated union rather than one flat record makes the code guarantee structural rather than documentary. A kind that is reached only BY
matching a code carries the code as a required field, so a caller narrowing to one of those reads a plain string with no undefined check to write. A kind reached
by a signal or by a name may or may not have passed a code on the way down, so there the field is optional.

`code` is typed as `string` rather than as a per-kind union of the codes that produce that kind. The map can learn another code for a kind it already produces,
which is an addition for a caller reading the code as a string and a breaking change for one switching over a literal union, so the looser type is deliberate.

***

### TransportFailureKind

```ts
type TransportFailureKind = 
  | "aborted"
  | "connect-timeout"
  | "destroyed"
  | "dns"
  | "refused"
  | "reset"
  | "retries-exhausted"
  | "timeout"
  | "transport";
```

The kinds of transport failure [classifyTransportError](#classifytransporterror) tells apart.

#### Remarks

What each kind means, and which observed shapes produce it:

- `"aborted"` - the lifetime signal passed to the classifier had already aborted, so this is a teardown rather than a fault. Produced by that signal alone, whatever
  shape the rejection itself took.
- `"connect-timeout"` - the connection attempt timed out before a request was ever written. Produced by `UND_ERR_CONNECT_TIMEOUT`.
- `"destroyed"` - the request was dispatched against a pool that has been torn down. Produced by `UND_ERR_DESTROYED`, which is how a request in flight when its
  dispatcher is destroyed settles.
- `"dns"` - the host name did not resolve. Produced by `ENOTFOUND`, and by `EAI_AGAIN`, the temporary-failure form a struggling resolver returns.
- `"refused"` - the host answered the connection attempt by declining it. Produced by `ECONNREFUSED` and `EHOSTDOWN`.
- `"reset"` - an established connection was dropped mid-exchange. Produced by `ECONNRESET`.
- `"retries-exhausted"` - the transport retried as it was configured to and ran out of attempts. Produced by `UND_ERR_REQ_RETRY`.
- `"timeout"` - a deadline elapsed. Produced by the platform `TimeoutError` from `AbortSignal.timeout()`, by this library's own watchdog timeouts, by a cancellation
  that is not the lifetime signal's, and by the response deadlines `UND_ERR_HEADERS_TIMEOUT` and `UND_ERR_BODY_TIMEOUT`.
- `"transport"` - a genuine failure carrying no marker anyone can read. The catch-all, and where a value that is not an error at all lands.

***

### classifyTransportError()

```ts
function classifyTransportError(error, signal?): TransportFailure;
```

Classify a thrown transport failure into one kind-tagged record.

Pure: no state, no clock, no logging, and nothing thrown back at the caller. Any value at all can be handed to it, including values that are not errors.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `error` | `unknown` | Whatever was thrown or rejected. |
| `signal?` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | The lifetime signal composed into the request, when there is one. Its aborted flag outranks every reading taken from the error itself. |

#### Returns

[`TransportFailure`](#transportfailure)

The classification, carrying the input verbatim as its `cause`.

#### Example

```ts
import { classifyTransportError } from "homebridge-plugin-utils";

try {

  return await this.fetchDevices();
} catch(error: unknown) {

  const failure = classifyTransportError(error, this.signal);

  // A teardown is not news. Everything else is this plugin's own protocol policy to phrase and to decide about.
  if(failure.kind === "aborted") {

    return null;
  }

  this.log.error("Unable to retrieve the device list.", { code: failure.code, kind: failure.kind });

  return null;
}
```
