/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * api-dispatcher.ts: A pooled HTTP dispatcher carrying vetted defaults for talking to a cloud API or a local gateway.
 */

/**
 * A pooled HTTP dispatcher carrying vetted defaults for talking to a cloud API or a local gateway.
 *
 * A plugin that talks to an HTTP API needs a connection pool, a retry policy for the statuses and faults worth retrying, and a user-agent on every request. None of
 * that is interesting work, all of it is the same work each time, and the copies drift in ways nobody notices until one of them misbehaves: a status list that has to
 * be kept in step by hand with the classification the plugin messages from, a keepalive that outlives the gateway reboot it was holding a socket through, a retry
 * curve tuned once and never revisited. This module owns that construction, so the interesting part - what a given API's statuses mean, and what the plugin does
 * about them - is all that is left to write.
 *
 * The retry status list is exported rather than merely applied, because two questions are the same list and drift the moment they are written down twice: what the
 * transport retries, and which statuses a plugin then describes as transient when the retries run out. {@link API_RETRY_STATUS_CODES} is the one declaration both
 * read.
 *
 * Construction costs nothing on the wire. The pool connects lazily, on the first request through it, so a dispatcher may be built during startup without any host
 * being reachable yet.
 *
 * Teardown has an upper bound rather than an instant. Abort your in-flight signals first, then destroy the dispatcher. A retry backoff pending at that moment is a
 * plain timer the retry interceptor owns, so a request waiting on one settles against the destroyed pool - as an error whose code is `UND_ERR_DESTROYED` - no later
 * than when that backoff elapses, and sooner when the destroy interrupts the exchange before a backoff is even scheduled. The linger is therefore bounded by the
 * configured `maxTimeout`, which is the number to size a shutdown budget against.
 *
 * @module
 */
import type { Dispatcher, RetryHandler } from "undici";
import { Pool, interceptors } from "undici";

/* The scalar half of the family's retry configuration, held once. The status list is deliberately NOT here: it is exported surface in its own right, and it has to be
 * copied rather than shared on each derivation, which a constant sitting in this object would quietly stop happening.
 */
const API_RETRY_DEFAULTS: RetryHandler.RetryOptions = Object.freeze({ maxRetries: 3, maxTimeout: 5000, minTimeout: 1000, timeoutFactor: 2 });

/* One entry of the tuple form of a dispatch's header set: a name beside its value. Written out here because the transport keeps that union's element type internal to
 * its own declarations, while a rewritten list has to be assignable back to it.
 */
type HeaderTuple = [ string, string | string[] | undefined ];

// Whether a materialized header entry is a name/value tuple rather than one of the alternating strings the flat form is made of.
function isHeaderTuple(entry: HeaderTuple | string): entry is HeaderTuple {

  return typeof entry !== "string";
}

// The complement, so the flat form's entries narrow to the strings they are.
function isHeaderName(entry: HeaderTuple | string): entry is string {

  return typeof entry === "string";
}

/* Return a header set carrying `name: value`, preserving everything already in `headers`.
 *
 * A dispatch accepts its headers in several shapes, and each one is rewritten in its own shape rather than normalized into a single form, because normalizing is
 * lossy: the list forms can carry a name more than once and a record cannot. Nothing the caller handed in is modified, since the options object belongs to whoever
 * dispatched the request.
 *
 * The name is matched case-insensitively throughout. HTTP header names are case-insensitive, so a stamp that sat beside a differently-cased twin instead of replacing
 * it would send the header twice.
 */
function stampHeaders(headers: Dispatcher.DispatchOptions["headers"], name: string, value: string): Dispatcher.DispatchOptions["headers"] {

  const lowered = name.toLowerCase();

  // With no headers at all there is nothing to preserve, so the stamp is the whole set.
  if((headers === undefined) || (headers === null)) {

    return { [name]: value };
  }

  // The record form, which is the one shape that is not iterable.
  if(!(Symbol.iterator in headers)) {

    const stamped = Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== lowered));

    stamped[name] = value;

    return stamped;
  }

  /* The list forms. Only their entries tell them apart: the tuple form pairs each name with its value, the flat form alternates names and values in a single run.
   * Materializing the iterable once serves both the reading and the rewrite, and settles a one-shot iterator that reading alone would otherwise consume.
   */
  const entries = [...headers];
  const tuples = entries.filter(isHeaderTuple);

  if(tuples.length > 0) {

    const existing = tuples.findIndex((entry) => entry[0].toLowerCase() === lowered);

    // A pair already carrying this name is overwritten where it sits, so the rest of the list keeps its order; otherwise the stamp joins the end.
    if(existing === -1) {

      tuples.push([ name, value ]);
    } else {

      tuples[existing] = [ name, value ];
    }

    return tuples;
  }

  // The flat form holds a name at every even index and its value at the odd index after it, so a match overwrites the following slot rather than its own.
  const flat = entries.filter(isHeaderName);
  const existing = flat.findIndex((entry, index) => ((index % 2) === 0) && (entry.toLowerCase() === lowered));

  if(existing === -1) {

    flat.push(name, value);
  } else {

    flat[existing + 1] = value;
  }

  return flat;
}

/**
 * The statuses a dispatcher from this module retries: `[ 400, 404, 429, 500, 502, 503, 504 ]`, frozen so the `readonly` type is enforced rather than advised.
 *
 * A plugin that tells a user "the request kept failing on a transient error" derives THAT set of statuses from this list instead of restating it, which is the one
 * place where what the transport retries and what the plugin then says about it are the same question. Every other status-to-message decision belongs to the plugin,
 * whose protocol it is.
 *
 * @remarks This is a deliberate widening of the transport's own retry defaults, which cover the 5xx family and 429 alone. Real APIs answer well-formed requests with
 * a transient 400 or 404 while a device is rebooting or a backend is under load, and treating either as permanent gives up on a request that would have succeeded a
 * second later.
 *
 * @category Utilities
 */
export const API_RETRY_STATUS_CODES: readonly number[] = Object.freeze([ 400, 404, 429, 500, 502, 503, 504 ]);

/**
 * Construction options for {@link createApiDispatcher}, and for the derivations behind it.
 *
 * @category Utilities
 */
export interface ApiDispatcherOptions {

  /**
   * Whether to offer HTTP/2 during connection negotiation. Defaults to `true`; a server that does not speak it simply stays on HTTP/1.1.
   */
  allowH2?: boolean;

  /**
   * How long, in milliseconds, a pooled connection may live before it is recycled. Defaults to `60000`, which bounds how long a keepalive socket to a host that has
   * since rebooted can linger. Pass `null` to disable recycling entirely, which is what a plugin holding long-lived connections to a local gateway wants.
   */
  clientTtl?: number | null;

  /**
   * How many connections the pool may open to the origin. Defaults to `1`, which is what an API client issuing one request at a time needs.
   */
  connections?: number;

  /**
   * The origin every request through this dispatcher is sent to.
   */
  origin: string | URL;

  /**
   * Whether to require a valid TLS certificate chain. Defaults to `true`. Relaxing it is occasionally the only way to reach a device shipping a certificate it
   * generated for itself, and a plugin that does relax it owns that decision.
   */
  rejectUnauthorized?: boolean;

  /**
   * The retry policy. Defaults to `{ maxRetries: 3, maxTimeout: 5000, minTimeout: 1000, statusCodes: API_RETRY_STATUS_CODES, timeoutFactor: 2 }`. An object supplied
   * here merges OVER those defaults field by field, so overriding `maxRetries` alone keeps the vetted status list. Pass `false` to compose no retry interceptor at
   * all, which is what a protocol that answers with a retryable-looking status to MEAN something - a 503 that says "not ready yet" rather than "try again" - needs,
   * since a retry would swallow the answer.
   *
   * @remarks These fields are the whole of what this module sets. Every other member of the transport's retry vocabulary keeps the transport's own default,
   * including the list of methods eligible for retry and the connection-fault `errorCodes` axis, which means resets, refusals, and unresolvable names are retried
   * underneath this policy whether or not any status is.
   */
  retry?: RetryHandler.RetryOptions | false;

  /**
   * The user-agent stamped onto every request this dispatcher sends.
   */
  userAgent: string;
}

/**
 * Derive the pool construction options from {@link ApiDispatcherOptions}, applying every default.
 *
 * Exported because it is the testable core of {@link createApiDispatcher} and because a plugin that needs a pool option this module does not surface can start from
 * the vetted base rather than from nothing.
 *
 * @param options - See {@link ApiDispatcherOptions}.
 *
 * @returns The pool options, carrying a `connect` entry only when the TLS check is being relaxed.
 *
 * @category Utilities
 */
export function apiPoolOptions(options: ApiDispatcherOptions): Pool.Options {

  return {

    allowH2: options.allowH2 ?? true,

    /* This one default cannot go through `??`. A null `clientTtl` is a meaningful value - it turns connection recycling off - and `??` would treat it as "nothing was
     * supplied" and hand back the number instead, quietly denying the one plugin that asked for it.
     */
    clientTtl: (options.clientTtl === undefined) ? 60000 : options.clientTtl,

    // The transport validates certificates by default, so only the relaxed case has anything to say and `true` adds no key at all.
    ...((options.rejectUnauthorized === false) ? { connect: { rejectUnauthorized: false } } : {}),
    connections: options.connections ?? 1
  };
}

/**
 * Derive the retry policy from the `retry` option, merging anything supplied over the defaults.
 *
 * @param retry - The `retry` option as written by the caller: an object to merge, `false` to opt out, or `undefined` to take the defaults whole.
 *
 * @returns The retry options to hand the interceptor, or `undefined` when no retry interceptor should be composed at all.
 *
 * @category Utilities
 */
export function apiRetryOptions(retry: ApiDispatcherOptions["retry"]): RetryHandler.RetryOptions | undefined {

  if(retry === false) {

    return undefined;
  }

  /* Only the fields the caller actually gave a value to are merged. Spreading the supplied object wholesale would copy keys whose value is `undefined` as well, and an
   * `undefined` reaching the transport does not mean "leave the default in place" - it means the transport substitutes its own narrower default. A caller writing
   * `{ maxRetries: 5, statusCodes: undefined }`, which is what a partly-populated config object produces, would silently lose the vetted status list that way.
   */
  const supplied = Object.fromEntries(Object.entries(retry ?? {}).filter(([ , value ]) => value !== undefined));

  /* The status list is copied fresh on every call. Freezing the exported constant protects the constant and not an array copied out of it, so one shared copy handed
   * back to every caller would let a single in-place `push` anywhere change what every later derivation returns.
   */
  return { ...API_RETRY_DEFAULTS, statusCodes: [...API_RETRY_STATUS_CODES], ...supplied };
}

/**
 * Build an interceptor that stamps one header onto every request dispatched through it.
 *
 * The mechanism is separate from any policy about which header to stamp: {@link createApiDispatcher} composes this with `"user-agent"`, and a plugin needing some
 * other per-request stamp - an API key, a correlation id - composes the same primitive with its own name and value.
 *
 * @param name  - The header name. Matched case-insensitively against whatever the request already carries, and any existing spelling of it is replaced.
 * @param value - The header value.
 *
 * @returns An interceptor, ready to pass to a dispatcher's `compose`.
 *
 * @category Utilities
 */
export function headerStampInterceptor(name: string, value: string): Dispatcher.DispatcherComposeInterceptor {

  return (dispatch) => (options, handler) => dispatch({ ...options, headers: stampHeaders(options.headers, name, value) }, handler);
}

/**
 * Build a pooled dispatcher for an HTTP API, with retries and a user-agent already composed in.
 *
 * The dispatcher is returned, not installed: a plugin holds it in a field, hands it to its own client, or installs it globally, as it prefers. Its lifetime is the
 * plugin's too - it is an ordinary transport dispatcher, so `destroy()` goes on whatever teardown stack the plugin already keeps, and rebuilding a wedged one is
 * another call to this function.
 *
 * @param options - See {@link ApiDispatcherOptions}.
 *
 * @returns The composed dispatcher.
 *
 * @example
 *
 * ```ts
 * import { createApiDispatcher } from "homebridge-plugin-utils";
 *
 * // Retries and the user-agent are already in place; nothing connects until the first request.
 * const dispatcher = createApiDispatcher({ origin: "https://api.example.com", userAgent: "my-plugin/1.0" });
 *
 * const response = await request("https://api.example.com/devices", { dispatcher, signal: this.signal });
 * ```
 *
 * @category Utilities
 */
export function createApiDispatcher(options: ApiDispatcherOptions): Dispatcher {

  const pool = new Pool(options.origin, apiPoolOptions(options));
  const stamp = headerStampInterceptor("user-agent", options.userAgent);
  const retry = apiRetryOptions(options.retry);

  // No retry policy means no retry interceptor, rather than an interceptor configured to do nothing: a status a plugin treats as an answer has to reach it untouched.
  if(retry === undefined) {

    return pool.compose(stamp);
  }

  return pool.compose(stamp, interceptors.retry(retry));
}
