/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * transport-error.test.ts: Unit tests for classifyTransportError - the precedence between the lifetime signal, the timeout shapes and the remaining cancellation
 * shapes, the transport and errno code map, the single walk down the cause chain and where it stops looking, and the thrown value carried back verbatim.
 *
 * The table below is the specification rather than a sample of it. Each row is an input shape and the exact record it must produce, and several rows exist purely to
 * fail an implementation that is plausible but wrong: the aborted-signal-with-an-errno row separates the correct precedence from one that consults the code map first,
 * the depth rows bracket the cap so no other cap passes both, the numeric-code rows pin that the platform's legacy numeric code is stepped over rather than
 * adopted, and the wrapped rows pin that the name checks ride the walk instead of reading only the value that was caught.
 */
import { describe, test } from "node:test";
import { HbpuAbortError } from "./util.ts";
import type { TransportFailureKind } from "./transport-error.ts";
import assert from "node:assert/strict";
import { classifyTransportError } from "./transport-error.ts";

// The states a caller's lifetime signal can be in at the moment a failure is classified.
type SignalState = "aborted" | "none" | "open";

// One row of the specification: an input shape, the signal it arrives with, and the exact classification it must produce.
interface FixtureRow {

  code: string | undefined;
  error: unknown;
  kind: TransportFailureKind;
  name: string;
  signal: SignalState;
}

// An error identified by its name alone, which is all the platform's cancellations and deadlines ever carry.
function named(name: string, cause?: unknown): Error {

  const error = (cause === undefined) ? new Error(name) : new Error(name, { cause });

  error.name = name;

  return error;
}

// An error carrying a transport or errno code. The code is loosely typed on purpose: the platform's own `DOMException` carries a numeric one.
function coded(code: number | string, cause?: unknown): Error {

  const error = (cause === undefined) ? new Error("transport failure.") : new Error("transport failure.", { cause });

  return Object.assign(error, { code });
}

// The shape a failed platform fetch presents to whoever called it: a `TypeError` saying nothing useful, with the errno one link below.
function fetchFailure(code: string): Error {

  return new TypeError("fetch failed", { cause: coded(code) });
}

// A stack of anonymous wrappers above an innermost value, for placing a marker at a chosen depth below the value a caller would have caught.
function nested(depth: number, innermost: unknown): unknown {

  let chain = innermost;

  for(let level = 0; level < depth; level++) {

    chain = new Error("wrapper.", { cause: chain });
  }

  return chain;
}

// Two errors naming each other as their cause. Nothing in the chain itself can end a walk down it, so only the depth cap can.
const cycleHead = new Error("outer.");
const cycleTail = new Error("inner.", { cause: cycleHead });

Object.assign(cycleHead, { cause: cycleTail });

const FIXTURES: readonly FixtureRow[] = [

  { code: undefined, error: named("TimeoutError"), kind: "timeout", name: "a platform deadline by name", signal: "none" },
  { code: undefined, error: named("AbortError"), kind: "aborted", name: "a cancellation under an aborted lifetime", signal: "aborted" },
  { code: undefined, error: named("AbortError"), kind: "timeout", name: "a cancellation under a live lifetime", signal: "open" },
  { code: undefined, error: named("AbortError"), kind: "timeout", name: "a cancellation with no lifetime signal", signal: "none" },
  { code: undefined, error: new HbpuAbortError("timeout"), kind: "timeout", name: "a watchdog timeout from this library", signal: "none" },
  { code: "UND_ERR_CONNECT_TIMEOUT", error: coded("UND_ERR_CONNECT_TIMEOUT"), kind: "connect-timeout", name: "a connect deadline", signal: "none" },
  { code: "UND_ERR_HEADERS_TIMEOUT", error: coded("UND_ERR_HEADERS_TIMEOUT"), kind: "timeout", name: "a header deadline", signal: "none" },
  { code: "UND_ERR_BODY_TIMEOUT", error: coded("UND_ERR_BODY_TIMEOUT"), kind: "timeout", name: "a body deadline", signal: "none" },
  { code: "UND_ERR_REQ_RETRY", error: coded("UND_ERR_REQ_RETRY"), kind: "retries-exhausted", name: "an exhausted retry budget", signal: "none" },
  { code: "UND_ERR_DESTROYED", error: coded("UND_ERR_DESTROYED"), kind: "destroyed", name: "a request against a destroyed pool", signal: "none" },
  { code: "UND_ERR_ABORTED", error: coded("UND_ERR_ABORTED"), kind: "timeout", name: "a transport cancellation under a live lifetime", signal: "open" },
  { code: "UND_ERR_ABORTED", error: coded("UND_ERR_ABORTED"), kind: "aborted", name: "a transport cancellation under an aborted lifetime", signal: "aborted" },

  { code: "UND_ERR_ABORTED", error: named("WrapError", coded("UND_ERR_ABORTED")), kind: "timeout", name: "a wrapped transport cancellation", signal: "open" },
  { code: "ECONNREFUSED", error: fetchFailure("ECONNREFUSED"), kind: "refused", name: "a refused connection", signal: "none" },
  { code: "EHOSTDOWN", error: fetchFailure("EHOSTDOWN"), kind: "refused", name: "a host that is down", signal: "none" },
  { code: "ECONNRESET", error: fetchFailure("ECONNRESET"), kind: "reset", name: "a reset connection", signal: "none" },
  { code: "ENOTFOUND", error: fetchFailure("ENOTFOUND"), kind: "dns", name: "a name that does not resolve", signal: "none" },
  { code: "EAI_AGAIN", error: coded("EAI_AGAIN"), kind: "dns", name: "a resolver failing temporarily", signal: "none" },
  { code: "ENOTFOUND", error: nested(2, coded("ENOTFOUND")), kind: "dns", name: "a code two links down", signal: "none" },
  { code: undefined, error: named("WrapError", named("TimeoutError")), kind: "timeout", name: "a wrapped deadline carrying no code", signal: "none" },
  { code: undefined, error: named("WrapError", named("AbortError")), kind: "timeout", name: "a wrapped cancellation carrying no code", signal: "open" },
  { code: undefined, error: named("TimeoutError"), kind: "aborted", name: "a deadline that raced a teardown", signal: "aborted" },
  { code: "ECONNRESET", error: named("TimeoutError", coded("ECONNRESET")), kind: "timeout", name: "a deadline over a reset connection", signal: "none" },
  { code: "ECONNRESET", error: coded("ECONNRESET", coded("ENOTFOUND")), kind: "reset", name: "the nearest of two codes", signal: "none" },
  { code: "ENOTFOUND", error: nested(8, coded("ENOTFOUND")), kind: "dns", name: "a code at the deepest link still read", signal: "none" },
  { code: undefined, error: nested(9, coded("ENOTFOUND")), kind: "transport", name: "a code one link past the cap", signal: "none" },
  { code: undefined, error: coded(20), kind: "transport", name: "a legacy numeric code alone", signal: "none" },
  { code: "ECONNREFUSED", error: coded(20, coded("ECONNREFUSED")), kind: "refused", name: "a legacy numeric code above an errno", signal: "none" },
  { code: undefined, error: cycleHead, kind: "transport", name: "a cause chain that refers back to itself", signal: "none" },
  { code: "EWEIRD", error: coded("EWEIRD"), kind: "transport", name: "a code with no kind of its own", signal: "none" },
  { code: undefined, error: "boom", kind: "transport", name: "a thrown string", signal: "none" },
  { code: undefined, error: undefined, kind: "transport", name: "a thrown undefined", signal: "none" },
  { code: "ECONNREFUSED", error: fetchFailure("ECONNREFUSED"), kind: "aborted", name: "an errno under an aborted lifetime", signal: "aborted" }
];

// Build the lifetime signal a row arrives with. Only the aborted flag is ever read, so the reason a signal carries is immaterial here.
function signalFor(state: SignalState): AbortSignal | undefined {

  switch(state) {

    case "aborted":

      return AbortSignal.abort();

    case "none":

      return undefined;

    case "open":

      return new AbortController().signal;
  }
}

describe("the transport error classifier", () => {

  for(const row of FIXTURES) {

    test("classifies " + row.name, () => {

      const failure = classifyTransportError(row.error, signalFor(row.signal));

      assert.equal(failure.kind, row.kind);
      assert.equal(failure.code, row.code);

      // Every classification hands the thrown value back untouched, whatever it was and whatever kind it produced, so a caller that wants to wrap or rethrow it still
      // has the original rather than a reconstruction of it.
      assert.equal(failure.cause, row.error);
    });
  }
});
