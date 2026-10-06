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
 * A request's own signal is answered for as long as its response has not started. An abort in that window settles the caller at once with the signal's reason, or
 * with the transport's request-aborted error when that reason is null or undefined, whether the request is waiting in the pool's queue, waiting on a connection, or
 * waiting out a retry backoff, and a request that aborted while it waited in the pool's queue costs no dial when the queue reaches it. Once the response has started,
 * an abort is the transport's to handle. The transport's queue never looks at a signal, so the composition answers it where the transport offers a hook: the pool
 * builds its connections from a client that drops a request whose signal has aborted, and a gate composed as the outermost layer releases the caller at the abort.
 * A dial already running at an abort still runs on to the configured `connectTimeout`, its caller already released. A released request's entry leaves the pool's
 * queue at the pool's next drain, so until then the pool's `queued` and `pending` figures count callers that have already been answered.
 *
 * Some requests stay outside that reach. `fetch` puts no signal on its dispatch, so a `fetch` waiting in the pool's queue still dials when the queue reaches it,
 * though `fetch` releases its own caller at the abort. A signal that is an event emitter rather than an `AbortSignal` takes the transport's own path. A request the
 * transport's connection recycling has already moved to a connection's own queue still costs that connection, and an aborted request already written to a connection
 * still triggers one more dial.
 *
 * Teardown has an upper bound rather than an instant. Abort your in-flight signals first, then destroy the dispatcher. The abort settles every caller whose response
 * has not started, at once and with its reason. A retry backoff pending at that moment is a plain timer the retry interceptor owns: while the pool is open, a backoff
 * whose attempt never reached a connection fires once into the client that drops the request and dials nothing, and one whose attempt was on a connection is cleared
 * by the abort of that attempt's controller. After `destroy()`, the pool refuses the backoff's re-dispatch with its destroyed error before any client sees it, and
 * the gate drops that error, since its caller has already been answered. A request that was not aborted first settles with that destroyed error, whose code is
 * `UND_ERR_DESTROYED`, no later than when its backoff elapses, and sooner when the destroy interrupts the exchange before a backoff is even scheduled.
 *
 * While the pool is open, a request waiting on a connection waits out every dial queued ahead of it, each bounded by `connectTimeout`, so its own wait grows with its
 * place in line until its signal ends it. `destroy()` settles every request still waiting at once, and only a dial already running goes on to `connectTimeout`, which
 * is where the transport abandons the attempt. A shutdown budget is therefore sized against `maxTimeout` and `connectTimeout` together.
 *
 * @module
 */
import { Client, Pool, errors, interceptors } from "undici";
import type { Dispatcher, RetryHandler } from "undici";
import type { Duplex } from "node:stream";
import { onAbort } from "./util.ts";

/* The scalar half of the family's retry configuration, held once. The status list is deliberately NOT here: it is exported surface in its own right, and it has to be
 * copied rather than shared on each derivation, which a constant sitting in this object would quietly stop happening.
 */
const API_RETRY_DEFAULTS = Object.freeze({ maxRetries: 3, maxTimeout: 5000, minTimeout: 1000, timeoutFactor: 2 } satisfies RetryHandler.RetryOptions);

// How long a connection attempt is given before it fails, in milliseconds. Held here so the derivation and the documented default cannot drift apart.
const DEFAULT_CONNECT_TIMEOUT = 5000;

/* One entry of the tuple form of a dispatch's header set: a name beside its value. Written out here because the transport keeps that union's element type internal to
 * its own declarations, while a rewritten list has to be assignable back to it.
 */
type HeaderTuple = [ string, string | string[] | undefined ];

/* The header record the transport hands a handler with a response and with its trailers. Read off the handler type itself rather than written out, because the
 * transport keeps the name of that record internal to its own declarations, and a type read from the handler cannot drift from what the handler is given.
 */
type ResponseHeaders = Parameters<Required<Dispatcher.DispatchHandler>["onResponseStart"]>[2];

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
 * @remarks This is a deliberate widening of the transport's own retry defaults, which cover 429, 500, 502, 503, and 504 alone. Real APIs answer well-formed requests
 * with a transient 400 or 404 while a device is rebooting or a backend is under load, and treating either as permanent gives up on a request that would have succeeded
 * a second later.
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
   * How long, in milliseconds, a connection attempt may take before it fails. Defaults to `5000`.
   *
   * The bound sits here rather than on the request because no signal can end a dial already running: the transport attaches a request's signal only once a
   * connection exists, and the gate that releases a caller at its abort leaves the dial itself to run...without this bound, an attempt to a host that never answers
   * runs on to the transport's own ten-second default, holding its socket long after its caller has been released. `5000` is the default because a local API answers
   * a connect in milliseconds, and the value matches the retry ladder's `maxTimeout`, so the bounds a shutdown budget includes sit in the same size class.
   */
  connectTimeout?: number;

  /**
   * How many connections the pool may open to the origin. Defaults to `1`, which is what an API client issuing one request at a time needs.
   */
  connections?: number;

  /**
   * The origin every request through this dispatcher is sent to.
   */
  origin: string | URL;

  /**
   * Whether to require a valid TLS certificate chain. Omitted, the dispatcher sets nothing and the platform decides: Node verifies the chain by default, and a process
   * started with `NODE_TLS_REJECT_UNAUTHORIZED=0` does not. `true` requires a chain the platform accepts, which no environment setting can relax. `false` verifies
   * nothing, which is occasionally the only way to reach a device shipping a certificate it generated for itself, and a plugin that does relax it owns that decision.
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
 * These options carry neither part of the answer to a request's own signal: {@link createApiDispatcher} supplies the client that drops an aborted request
 * where it builds the pool and composes the gate above it, so a pool built from these options alone keeps the transport's own handling, in which an aborted request
 * waits in the pool's queue until a connection takes it. The gate is the outermost layer of this module's composition alone, so a layer a plugin composes above the
 * returned dispatcher sits above it.
 *
 * @param options - See {@link ApiDispatcherOptions}.
 *
 * @returns The pool options, whose `connect` entry always carries the connect timeout and adds the caller's certificate setting whenever they stated one, in
 *          whichever direction they stated it.
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

    /* The connect entry always carries the timeout. The certificate setting joins it exactly when the caller stated one, in whichever direction they stated it - so a
     * caller asking for verification gets a dial that requires it, and one saying nothing leaves the question where the platform answers it.
     */
    connect: { ...((options.rejectUnauthorized === undefined) ? {} : { rejectUnauthorized: options.rejectUnauthorized }),
      timeout: options.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT },
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

/* The `AbortSignal` a request carries on its dispatch options, or nothing. The transport's options type declares no signal, though its request APIs put the caller's
 * there, so the member is found by asking for it rather than by a cast. Only a real `AbortSignal` is answered: the transport also accepts an event emitter as a
 * signal, and a request carrying one takes the transport's own path untouched.
 */
function requestSignal(options: Dispatcher.DispatchOptions): AbortSignal | undefined {

  return (("signal" in options) && (options.signal instanceof AbortSignal)) ? options.signal : undefined;
}

/* A signal as the abort helpers read it. The platform types a signal's reason as `any`, and the transport hands whatever a signal holds to a handler whose error
 * parameter it types as an `Error`, so the reason is declared here in the handler's terms. That is what lets an `AbortSignal` be passed in without a cast, while
 * the value itself goes through untouched, whatever it is.
 */
interface AbortReasonSource {

  readonly reason: Error | null | undefined;
}

/* The error a handler is settled with for an aborted signal: the signal's own reason, or the transport's request-aborted error when that reason is null or undefined,
 * the rule the transport's request API applies to a signal of its own. Every settle and every late abort reads its error here.
 */
function abortError({ reason }: AbortReasonSource): Error {

  return reason ?? new errors.RequestAbortedError();
}

// What the controller of a settled request does when asked to abort, pause or resume: nothing, since the request it reports on holds no connection to act on.
function inert(): void {

  // Intentionally empty - nothing beneath a settled request is left to act on.
}

/* The controller a settle hands a handler, in the state the transport's own abort leaves a controller in: reading aborted and carrying the error. Reading aborted is
 * what makes a retry policy pass the error up rather than try again, whatever the error carries. `aborted` is declared as the literal `true`, so no settle can be
 * written whose controller reads otherwise.
 */
interface AbortedController extends Dispatcher.DispatchController {

  readonly aborted: true;
  readonly reason: Error;
}

/* Settle a request as aborted, for the pool's client and the gate alike: the handler's `onResponseError` receives the error beside a controller built for this one
 * call. The controller is inert, because a request settled here holds no connection to abort, pause or resume.
 */
function settleAborted(handler: Dispatcher.DispatchHandler, error: Error): void {

  const controller: AbortedController = { abort: inert, aborted: true, pause: inert, paused: false, reason: error, resume: inert };

  handler.onResponseError?.(controller, error);
}

/* The client the pool builds its connections from. Its one difference from the transport's own is `dispatch`, which settles a request whose signal has already
 * aborted instead of taking it, so a request that aborted while it waited in the pool's queue is dropped when the queue reaches it and costs no dial. It exists only
 * because the transport's queue never looks at a signal, and it has no reason to exist once that queue honors one.
 *
 * The true answer for a dropped request keeps the pool's queue moving: the pool reads it as "not busy" and hands this client the next request in line, which is
 * accurate, since the client took nothing. A client that is closed or destroyed is left to answer as the transport does, with its own closed or destroyed error.
 */
class AbortDropClient extends Client {

  public override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {

    const signal = requestSignal(options);

    if(signal?.aborted && !this.closed && !this.destroyed) {

      settleAborted(handler, abortError(signal));

      return true;
    }

    return super.dispatch(options, handler);
  }
}

/* The life of one gated request. `waiting` is the only state holding anything: the abort listener's disposer, and the controller of the attempt a connection has
 * taken, which `onRequestStart` records once one has. `passthrough` leaves the request to the transport for good. `settled` means the caller has already been
 * answered, and everything still arriving from beneath is dropped.
 */
interface WaitingState {

  controller: Dispatcher.DispatchController | null;
  readonly kind: "waiting";
  readonly listener: Disposable;
}

interface PassthroughState {

  readonly kind: "passthrough";
}

interface SettledState {

  readonly kind: "settled";
}

// The states that hold nothing are shared, one instance each.
const PASSTHROUGH: PassthroughState = { kind: "passthrough" };
const SETTLED: SettledState = { kind: "settled" };

/* The handler the gate puts between a request and its caller. It declares every member of the transport's handler type, so no callback can be left out of the
 * forwarding, and each member forwards to the caller's own only where the caller defines it.
 */
class AbortGateHandler implements Required<Dispatcher.DispatchHandler> {

  readonly #caller: Dispatcher.DispatchHandler;
  readonly #signal: AbortSignal;
  #state: PassthroughState | SettledState | WaitingState;

  public constructor(signal: AbortSignal, caller: Dispatcher.DispatchHandler) {

    this.#caller = caller;
    this.#signal = signal;

    /* The gate is born waiting, its listener armed on a signal the interceptor has already found live, so the listener runs only later and never inside its own
     * arming. The listener reads the waiting state it was armed with rather than asking which state is current, because it can only ever run while that state is
     * current: leaving it removes the listener, and a listener removed while an abort is being dispatched is not called.
     */
    const waiting: WaitingState = { controller: null, kind: "waiting", listener: onAbort(signal, (): void => this.#abortWaiting(waiting)) };

    this.#state = waiting;
  }

  /* Dispatch the request through the layers beneath with this gate as its handler. A synchronous throw from beneath settles the gate, which releases its listener,
   * and goes on to the dispatch's own caller untouched.
   */
  public dispatchThrough(dispatch: Dispatcher.Dispatch, options: Dispatcher.DispatchOptions): boolean {

    try {

      return dispatch(options, this);
    } catch(error: unknown) {

      this.#transition(SETTLED);

      throw error;
    }
  }

  public onBodySent(chunk: Buffer): void {

    if(this.#reaches(false)) {

      this.#caller.onBodySent?.(chunk);
    }
  }

  public onRequestSent(): void {

    if(this.#reaches(false)) {

      this.#caller.onRequestSent?.();
    }
  }

  public onRequestStart(controller: Dispatcher.DispatchController, context: unknown): void {

    const state = this.#state;

    // A connection has taken a request whose caller was already answered, so the attempt is aborted before it is written rather than left holding the connection.
    if(state.kind === "settled") {

      controller.abort(abortError(this.#signal));

      return;
    }

    // Recorded on every attempt the retry interceptor starts, so an abort also tears down an attempt started after an earlier one failed.
    if(state.kind === "waiting") {

      state.controller = controller;
    }

    this.#caller.onRequestStart?.(controller, context);
  }

  public onRequestUpgrade(controller: Dispatcher.DispatchController, statusCode: number, headers: ResponseHeaders, socket: Duplex): void {

    if(this.#reaches(true)) {

      this.#caller.onRequestUpgrade?.(controller, statusCode, headers, socket);
    }
  }

  public onResponseData(controller: Dispatcher.DispatchController, chunk: Buffer): void {

    if(this.#reaches(false)) {

      this.#caller.onResponseData?.(controller, chunk);
    }
  }

  public onResponseEnd(controller: Dispatcher.DispatchController, trailers: ResponseHeaders): void {

    if(this.#reaches(true)) {

      this.#caller.onResponseEnd?.(controller, trailers);
    }
  }

  /* The transport passes null as the controller here on its closed and destroyed paths, though its type declares one, so this member reads nothing from the
   * controller and hands on exactly what it received.
   */
  public onResponseError(controller: Dispatcher.DispatchController, error: Error): void {

    if(this.#reaches(true)) {

      this.#caller.onResponseError?.(controller, error);
    }
  }

  // An informational status arrives through this same callback ahead of the final response, which has not started yet, so only a final status stands the gate down.
  public onResponseStart(controller: Dispatcher.DispatchController, statusCode: number, headers: ResponseHeaders, statusMessage?: string): void {

    if(this.#reaches(statusCode >= 200)) {

      this.#caller.onResponseStart?.(controller, statusCode, headers, statusMessage);
    }
  }

  public onResponseStarted(): void {

    if(this.#reaches(false)) {

      this.#caller.onResponseStarted?.();
    }
  }

  /* The signal aborted while the request waits. The caller is answered first, with its reason, and only then is an attempt a connection has already taken torn down
   * through its own controller, as the transport's own abort tears it down, so whatever that teardown sends back up finds the gate settled and is dropped.
   */
  #abortWaiting(waiting: WaitingState): void {

    const error = abortError(this.#signal);

    this.#transition(SETTLED);
    settleAborted(this.#caller, error);
    waiting.controller?.abort(error);
  }

  /* Whether a callback from beneath reaches the caller. Nothing does once the caller has been answered. A callback that ends the wait - a final response, an upgrade,
   * an end, an error - stands the gate down first, since from then on the request is the transport's, and the transport's own abort handling is what a later abort
   * meets.
   */
  #reaches(endsWait: boolean): boolean {

    if(this.#state.kind === "settled") {

      return false;
    }

    if(endsWait) {

      this.#transition(PASSTHROUGH);
    }

    return true;
  }

  // The one place the gate's state changes. Leaving `waiting` releases the abort listener, so no listener of the gate's outlives the wait it was armed for.
  #transition(next: PassthroughState | SettledState): void {

    if(this.#state.kind === "waiting") {

      this.#state.listener[Symbol.dispose]();
    }

    this.#state = next;
  }
}

/* The gate: an interceptor that answers a request's own signal while the request's response has not started. An abort in that window releases the caller at once
 * with the signal's reason, and an attempt a connection has already taken is aborted as the transport itself would abort it. It exists only because the transport's
 * queue never looks at a signal, so a caller whose request waits there would otherwise be answered only when the queue reached it, and it has no reason to exist
 * once that queue honors one.
 *
 * It is the outermost layer of this module's composition and of nothing beyond it. A layer a plugin composes above the returned dispatcher - its own retry
 * interceptor among them - sits above the gate, and sees a request the gate settled as an aborted one, which is what keeps a retry policy there from trying it again.
 */
function abortGateInterceptor(dispatch: Dispatcher.Dispatch): Dispatcher.Dispatch {

  return (options, handler): boolean => {

    const signal = requestSignal(options);

    // A request carrying no `AbortSignal` takes the transport's own path, with the caller's own handler.
    if(signal === undefined) {

      return dispatch(options, handler);
    }

    /* A signal that has already aborted is answered here, before anything is armed, and nothing is dispatched. This check and the arming that follows for a live
     * signal are one synchronous step, so nothing can abort the signal between them.
     */
    if(signal.aborted) {

      settleAborted(handler, abortError(signal));

      return true;
    }

    return new AbortGateHandler(signal, handler).dispatchThrough(dispatch, options);
  };
}

/**
 * Build a pooled dispatcher for an HTTP API, with retries and a user-agent already composed in.
 *
 * The dispatcher is returned, not installed: a plugin holds it in a field, hands it to its own client, or installs it globally, as it prefers. Its lifetime is the
 * plugin's too - it is an ordinary transport dispatcher, so `destroy()` goes on whatever teardown stack the plugin already keeps, and rebuilding a wedged one is
 * another call to this function.
 *
 * The composition also answers a request's own signal while its response has not started, through the client the pool builds and a gate composed outermost, and
 * the options carry neither. The gate is the outermost layer of this module's composition alone, so a layer a plugin composes above the returned dispatcher - its
 * own retry interceptor among them - sits above the gate and sees a request the gate released as an aborted one.
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

  /* The pool builds its clients through a factory supplied here, beside the derived options rather than among them, so the derivation stays plain data a plugin
   * can start a pool of its own from.
   */
  const pool = new Pool(options.origin, { ...apiPoolOptions(options), factory: (origin, clientOptions): Dispatcher => new AbortDropClient(origin, clientOptions) });
  const stamp = headerStampInterceptor("user-agent", options.userAgent);
  const retry = apiRetryOptions(options.retry);

  /* The layers are listed innermost first, since the last one composed is the outermost, and listed once, so their order has one home. The gate comes last, above the
   * retry interceptor, so a caller waiting out a backoff is released at its abort as well. No retry policy means no retry interceptor, rather than an interceptor
   * configured to do nothing: a status a plugin treats as an answer has to reach it untouched.
   */
  return pool.compose([ stamp, ...((retry === undefined) ? [] : [interceptors.retry(retry)]), abortGateInterceptor ]);
}
