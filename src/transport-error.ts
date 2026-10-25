/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * transport-error.ts: One kind-tagged reading of whatever a transport threw, so callers branch on a taxonomy rather than on error shapes.
 */

/**
 * One kind-tagged reading of whatever a transport threw.
 *
 * A plugin talking to a cloud API or a local gateway has to answer the same question before it can log, wrap, or retry anything: what kind of failure was that? The
 * raw material is unhelpful. A connection fault arrives as an errno string sitting on an error several `cause` links below the one that was caught. A deadline arrives
 * as a platform `TimeoutError` whose only marker is its `name`. A shutdown arrives as an `AbortError` that is shaped exactly like a deadline. A transport that gave up
 * retrying arrives as a code of its own. Working that out is the same walk, the same name checks, and the same code map every time, and each hand-written copy of it
 * drifts from the others.
 *
 * This module owns that derivation and stops there. It answers what kind of failure occurred; it does not decide what that means. Which failures are worth retrying,
 * which deserve a warning rather than a debug line, and how any of it is phrased to a user all stay with the caller, because they belong to a protocol this module
 * knows nothing about.
 *
 * The precedence is fixed, and each step exists because the step below it cannot tell the case apart:
 *
 * 1. The lifetime signal, if it has aborted. A teardown reads as a teardown whatever the rejection looked like.
 * 2. A timeout shape anywhere in the cause chain.
 * 3. A remaining cancellation shape, which belongs to the per-request deadline once the lifetime signal is ruled out.
 * 4. The transport and errno codes, mapped to their kinds.
 * 5. Everything else, which is a real failure carrying no marker anyone can read.
 *
 * Composing with it. It reads exactly ONE signal, so pass the lifetime signal you compose into your requests; a caller that composes further
 * cancellation sources beyond a lifetime bound and a per-request deadline ranks those itself before calling here. And the record it returns is a classification, never
 * something to throw: a caller's own error or fault type owns any wrap-and-rethrow it wants, including passing an already-classified failure straight through.
 *
 * @module
 */
import { causeChain, isTimeoutReason } from "./util.ts";

/* The verdicts the platform's certificate verification can return, each spelled as Node spells it on the error's `code`: the OpenSSL X509 verification family Node
 * maps by name, together with the hostname check Node runs itself.
 *
 * Neighbors from that same table are left out on purpose. `OUT_OF_MEM` is the verifier running out of room rather than a verdict about the certificate, so a
 * failure carrying it tells a user nothing that installing a certificate would fix. `CERT_DIR`, `CERT_FILE`, `CERT_STORE`, `CERT_ALTNAME_FORMAT`,
 * `UNABLE_TO_CHECK_GENERATOR`, and `UNABLE_TO_PIPE` are not verification verdicts at all - they are store locations and unrelated failures that share the
 * library's naming.
 */
const CERTIFICATE_VERIFICATION_CODES: ReadonlySet<string> = new Set([ "CERT_CHAIN_TOO_LONG", "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "CERT_REJECTED",
  "CERT_REVOKED", "CERT_SIGNATURE_FAILURE", "CERT_UNTRUSTED", "CRL_HAS_EXPIRED", "CRL_NOT_YET_VALID", "CRL_SIGNATURE_FAILURE", "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID", "ERROR_IN_CERT_NOT_AFTER_FIELD", "ERROR_IN_CERT_NOT_BEFORE_FIELD", "ERROR_IN_CRL_LAST_UPDATE_FIELD",
  "ERROR_IN_CRL_NEXT_UPDATE_FIELD", "HOSTNAME_MISMATCH", "INVALID_CA", "INVALID_PURPOSE", "PATH_LENGTH_EXCEEDED", "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY", "UNABLE_TO_DECRYPT_CERT_SIGNATURE", "UNABLE_TO_DECRYPT_CRL_SIGNATURE", "UNABLE_TO_GET_CRL",
  "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ]);

// Everything one descent of a `cause` chain collects, and the whole of what the classification reads afterwards.
interface CauseWalk {

  // Whether any link is an `Error` whose name marks it a cancellation. The platform cancels in more than one shape - a `DOMException` whose only code is a legacy number,
  // and the runtime's own `AbortError` carrying a string code - so the name is the one signal every shape shares.
  abortNamed: boolean;

  // The first string-valued `code` found, nearest link first, or `undefined` when no link carried one.
  code: string | undefined;

  // Whether any link reads as a timeout, in either the platform's shape or this library's.
  timedOut: boolean;
}

/* Read every fact the classification needs off one bounded descent of the `cause` chain, the same descent the library's error formatter reads for its sentences.
 *
 * One walk rather than one per question is what makes a wrapped failure classify as its bare equivalent does. A caller's own error type carrying a platform rejection
 * as its `cause` presents the timeout or cancellation marker one level down, so reading the names only at the top would classify the wrapper by what it is not, while
 * reading them at every link classifies it by what it carries.
 *
 * A `code` that is not a string is skipped rather than adopted, and skipping it does not stop the descent: the platform's `DOMException` carries a legacy numeric
 * `code` that means nothing here, and the errno the caller actually needs is usually below it.
 */
function walkCauses(error: unknown): CauseWalk {

  const walk: CauseWalk = { abortNamed: false, code: undefined, timedOut: false };

  for(const link of causeChain(error)) {

    if(isTimeoutReason(link)) {

      walk.timedOut = true;
    }

    if((link instanceof Error) && (link.name === "AbortError")) {

      walk.abortNamed = true;
    }

    // The nearest code wins, so once one is held the deeper ones are passed over. Only an object carries a code at all, and the descent ends on a link that is not
    // one, so that link answers the name checks above and nothing further.
    if((walk.code === undefined) && (typeof link === "object") && (link !== null) && ("code" in link) && (typeof link.code === "string")) {

      walk.code = link.code;
    }
  }

  return walk;
}

/**
 * The kinds of transport failure {@link classifyTransportError} tells apart.
 *
 * @remarks What each kind means, and which observed shapes produce it:
 *
 * - `"aborted"` - the lifetime signal passed to the classifier had already aborted, so this is a teardown rather than a fault. Produced by that signal alone, whatever
 *   shape the rejection itself took.
 * - `"certificate"` - the peer's certificate did not pass the platform's verification. Produced by the platform's own certificate verdict codes, which are read as a
 *   family rather than one name at a time.
 * - `"connect-timeout"` - the connection attempt timed out before a request was ever written. Produced by `UND_ERR_CONNECT_TIMEOUT`.
 * - `"destroyed"` - the request was dispatched against a pool that has been torn down. Produced by `UND_ERR_DESTROYED`, which is how a request in flight when its
 *   dispatcher is destroyed settles.
 * - `"dns"` - the host name did not resolve. Produced by `ENOTFOUND`, and by `EAI_AGAIN`, the temporary-failure form a struggling resolver returns.
 * - `"refused"` - the host answered the connection attempt by declining it. Produced by `ECONNREFUSED`.
 * - `"reset"` - an established connection was dropped mid-exchange. Produced by `ECONNRESET`.
 * - `"retries-exhausted"` - the transport retried as it was configured to and ran out of attempts. Produced by `UND_ERR_REQ_RETRY`.
 * - `"timeout"` - a deadline elapsed. Produced by the platform `TimeoutError` from `AbortSignal.timeout()`, by this library's own watchdog timeouts, by a cancellation
 *   that is not the lifetime signal's, and by the response deadlines `UND_ERR_HEADERS_TIMEOUT` and `UND_ERR_BODY_TIMEOUT`.
 * - `"transport"` - a genuine failure carrying no marker anyone can read. The catch-all, and where a value that is not an error at all lands.
 * - `"unreachable"` - the peer could not be reached, so nothing answered rather than the host declining. Produced by `EHOSTUNREACH` and `ENETUNREACH`, where no
 *   route leads to the peer, by `ENETDOWN` and `EHOSTDOWN`, where the network or the host is down, and by `ETIMEDOUT`, the platform's own timer giving up on a peer
 *   that stopped answering.
 *
 * @category Utilities
 */
export type TransportFailureKind = TransportFailure["kind"];

/**
 * A classified transport failure: `kind` is the taxonomy answer, `cause` is the thrown value verbatim, and `code` is the transport or errno code the cause chain
 * carried, when it carried one.
 *
 * Splitting this into a discriminated union rather than one flat record makes the code guarantee structural rather than documentary. A kind that is reached only BY
 * matching a code carries the code as a required field, so a caller narrowing to one of those reads a plain string with no undefined check to write. A kind reached
 * by a signal or by a name may or may not have passed a code on the way down, so there the field is optional.
 *
 * `code` is typed as `string` rather than as a per-kind union of the codes that produce that kind. The map can learn another code for a kind it already produces,
 * which is an addition for a caller reading the code as a string and a breaking change for one switching over a literal union, so the looser type is deliberate.
 *
 * @category Utilities
 */
export type TransportFailure = {

  readonly cause: unknown;
  readonly code: string;
  readonly kind: "certificate" | "connect-timeout" | "destroyed" | "dns" | "refused" | "reset" | "retries-exhausted" | "unreachable";
} | {

  readonly cause: unknown;
  readonly code?: string;
  readonly kind: "aborted" | "timeout" | "transport";
};

/**
 * The kinds of transport failure that are reached only by matching a code: the arm of {@link TransportFailure} whose `code` is a required field rather than an
 * optional one.
 *
 * The union already carries that set structurally, so a consumer keying an exhaustive table on it - one sentence of remedy per coded kind, say - can recover the
 * set with an `Extract` over the union's shape. Naming it here gives that consumer the library's own concept to key on instead, and leaves the derivation in the
 * one place that owns the taxonomy, so a kind that joins the coded arm reaches every such table at once.
 *
 * @category Utilities
 */
export type TransportFailureCodedKind = Extract<TransportFailure, { code: string }>["kind"];

/**
 * Classify a thrown transport failure into one kind-tagged record.
 *
 * Pure: no state, no clock, no logging, and nothing thrown back at the caller. Any value at all can be handed to it, including values that are not errors.
 *
 * @param error  - Whatever was thrown or rejected.
 * @param signal - The lifetime signal composed into the request, when there is one. Its aborted flag outranks every reading taken from the error itself.
 *
 * @returns The classification, carrying the input verbatim as its `cause`.
 *
 * @example
 *
 * ```ts
 * import { classifyTransportError } from "homebridge-plugin-utils";
 *
 * try {
 *
 *   return await this.fetchDevices();
 * } catch(error: unknown) {
 *
 *   const failure = classifyTransportError(error, this.signal);
 *
 *   // A teardown is not news. Everything else is this plugin's own protocol policy to phrase and to decide about, and connectionFaultLevel answers the level a
 *   // connection fault is logged at.
 *   if(failure.kind === "aborted") {
 *
 *     return null;
 *   }
 *
 *   throw new DeviceListError("Unable to retrieve the device list.", { cause: error, kind: failure.kind });
 * }
 * ```
 *
 * @category Utilities
 */
export function classifyTransportError(error: unknown, signal?: AbortSignal): TransportFailure {

  const walk = walkCauses(error);

  /* The lifetime signal outranks every reading taken from the error, unconditionally. Near a deadline boundary the rejection a composed cancellation produces is
   * ambiguous about which half of it fired, and the ways of being wrong here are not equally cheap: a teardown reported as a transport fault is an alarming line in a
   * log that should have stayed quiet, while a deadline reported during a teardown already underway costs nothing at all.
   */
  if(signal?.aborted === true) {

    return { cause: error, code: walk.code, kind: "aborted" };
  }

  // A deadline in either the platform's shape or this library's, found at any depth.
  if(walk.timedOut) {

    return { cause: error, code: walk.code, kind: "timeout" };
  }

  /* A cancellation that is not the lifetime signal's. The signature takes a single signal because the composition it assumes is a lifetime bound plus a per-request
   * deadline, and with the lifetime ruled out one step above, the deadline is what is left. A caller that composes some third cancellation source ranks that source
   * itself before calling here.
   */
  if(walk.abortNamed || (walk.code === "UND_ERR_ABORTED")) {

    return { cause: error, code: walk.code, kind: "timeout" };
  }

  /* The code map. The transport's own codes and the platform's errno strings share one namespace here because a caller cares which failure it was, not which layer
   * named it.
   */
  switch(walk.code) {

    case "UND_ERR_CONNECT_TIMEOUT":

      return { cause: error, code: walk.code, kind: "connect-timeout" };

    // A server that stops answering partway through a response has timed out in every sense a caller would phrase it, so the response deadlines answer to the
    // timeout kind rather than becoming kinds of their own.
    case "UND_ERR_BODY_TIMEOUT":
    case "UND_ERR_HEADERS_TIMEOUT":

      return { cause: error, code: walk.code, kind: "timeout" };

    case "UND_ERR_REQ_RETRY":

      return { cause: error, code: walk.code, kind: "retries-exhausted" };

    case "UND_ERR_DESTROYED":

      return { cause: error, code: walk.code, kind: "destroyed" };

    case "ECONNREFUSED":

      return { cause: error, code: walk.code, kind: "refused" };

    case "ECONNRESET":

      return { cause: error, code: walk.code, kind: "reset" };

    // None of these is the host declining the attempt: no route leads to the peer, the network or the host is down, or the platform's own timer gave up on a peer
    // that never answered, so each is a peer out of reach rather than one that refused.
    case "EHOSTDOWN":
    case "EHOSTUNREACH":
    case "ENETDOWN":
    case "ENETUNREACH":
    case "ETIMEDOUT":

      return { cause: error, code: walk.code, kind: "unreachable" };

    case "EAI_AGAIN":
    case "ENOTFOUND":

      return { cause: error, code: walk.code, kind: "dns" };

    /* A code that matched no name above is worth one more question: whether it is one of the platform's certificate verdicts. Those are a family rather than a
     * handful of names, so they are held as a set the map consults here...spelling them out as `case` labels would state the family in the wrong place, and would
     * make every addition to it an edit of this `switch`.
     */
    default:

      if((walk.code !== undefined) && CERTIFICATE_VERIFICATION_CODES.has(walk.code)) {

        return { cause: error, code: walk.code, kind: "certificate" };
      }

      // A real failure with nothing recognizable on it. Any code the chain did carry is carried through regardless, because a code nobody has a kind for is still
      // the most useful thing a caller can put in a log line.
      return { cause: error, code: walk.code, kind: "transport" };
  }
}
