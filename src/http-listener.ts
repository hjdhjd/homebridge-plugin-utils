/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * http-listener.ts: A signal-scoped HTTP listener with exact-path and catch-all routes, a bounded body read, and a clock-driven bind retry.
 */

/**
 * One plugin-hosted HTTP listener, shaped to the library's own lifecycle model.
 *
 * A plugin that has to answer HTTP - an inbound delivery a controller posts, a document a media player fetches, a redirect an authorization flow lands on - needs
 * the same machinery every time: a server whose lifetime is an {@link AbortSignal}, a port that is retried while something else holds it, a way to say which paths it
 * answers and with which methods, a body read that refuses to buffer without bound, and a teardown that releases the port rather than leaking it across a plugin
 * reload. That machinery is what this module owns, and it is all it owns: which port, which paths, what a request means, and what the answer is are the consumer's,
 * handed in as options and as a handler.
 *
 * The pieces:
 *
 * - {@link HttpListener} - the listener itself. Its lifetime is `signal`, composed from the caller's and its own; the signal firing closes the server, drops every
 *   connection so the port is releasable at once, cancels a pending bind retry, and releases every registered route.
 * - {@link HttpListener.route} - register a handler for one exact path, or for {@link HTTP_LISTENER_ANY_PATH}, the catch-all a route claims to answer every request
 *   no exact route claims. Registration answers a {@link Disposable} that releases the path.
 * - {@link HttpListenerHandler} - the route contract: a synchronous function from a {@link HttpListenerRequest} to a {@link HttpListenerResponse}. Synchronous is the
 *   contract rather than an accommodation, because the answer is written the moment the handler returns, which keeps a delivery inside the sender's own receive
 *   budget and leaves nothing that can outlive the listener.
 *
 * Every lifecycle line the listener writes carries the consumer's `label`, so the wording is the library's and uniform across plugins while the purpose still reads
 * in each line ("The document server is listening on port 10110.").
 *
 * This module imports `node:http` and is therefore Node-only, like `util.ts`. A browser-targeted consumer cannot resolve that import.
 *
 * @module
 */
import { HbpuAbortError, composeSignals, formatErrorMessage, formatMs, guardedDispatch, hasErrorCode, markHandled, onAbort, retry, superviseLoop } from "./util.ts";
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, Server, ServerResponse } from "node:http";
import type { Clock } from "./clock.ts";
import type { HomebridgePluginLogging } from "./util.ts";
import { createServer } from "node:http";
import { once } from "node:events";

// The default ceiling on a request body, in bytes. Sixty-four kilobytes is generous for the payloads a plugin listener actually answers - an inbound delivery, a form
// post, a control message - and small enough that a peer cannot make the process buffer its way into trouble. A consumer whose payloads are larger names its own.
const HTTP_LISTENER_BODY_LIMIT = 65536;

// The default wait between bind attempts, in milliseconds. Five seconds recovers quickly from the usual cause of a held port - a previous instance of this same
// process still letting go of it during a restart - without hammering the port.
const HTTP_LISTENER_RETRY_MS = 5000;

/**
 * The path a route claims to answer every request no exact route claims.
 *
 * A symbol rather than a string or `null`: a sentinel that must never collide with a path a sender can address has to be something no sender can spell, and the
 * constant reads at the call site as what it is - `listener.route(HTTP_LISTENER_ANY_PATH, handler)`.
 *
 * @category Utilities
 */
export const HTTP_LISTENER_ANY_PATH: unique symbol = Symbol("HttpListenerAnyPath");

/**
 * What a route is registered under: one exact path, or {@link HTTP_LISTENER_ANY_PATH} for the catch-all.
 *
 * @category Utilities
 */
export type HttpListenerPath = string | typeof HTTP_LISTENER_ANY_PATH;

/**
 * Construction options for {@link HttpListener}.
 *
 * @category Utilities
 */
export interface HttpListenerOptions {

  /**
   * The largest request body a route will be handed, in bytes. A body that crosses it is refused with 413 and never reaches a handler. Defaults to 65536.
   */
  bodyLimit?: number;

  /**
   * Optional time source for the bind retry's waits, handed through to `retry()`. Defaults to `systemClock`; a `TestClock` puts the retry schedule on virtual time.
   */
  clock?: Clock;

  /**
   * The noun phrase every one of this listener's log lines names it by - "event receiver", "document server". Required, because the library owns the wording of
   * those lines and the label is what carries the purpose in them. An empty label is refused.
   */
  label: string;

  /**
   * Where the listener's own lines go.
   */
  log: HomebridgePluginLogging;

  /**
   * The port to bind. Zero asks the operating system for an ephemeral one, which {@link HttpListener.boundPort} then reports.
   */
  port: number;

  /**
   * How long to wait before retrying a port that was in use. Defaults to 5000.
   */
  retryMs?: number;

  /**
   * The caller's lifetime, composed into {@link HttpListener.signal}. Firing it closes the listener for good.
   */
  signal?: AbortSignal;
}

/**
 * One request, as a route sees it.
 *
 * @category Utilities
 */
export interface HttpListenerRequest {

  /**
   * The body exactly as it arrived. It stays raw bytes because a signature covers what was sent: parsing and re-serializing a payload before verification would
   * change the whitespace and key order the signature was computed over and turn every authentic delivery into a refusal.
   */
  readonly body: Buffer;

  /**
   * The headers as Node parsed them. A consumer picks the header it cares about and applies its own rule for the string-or-array shape Node hands back, because what
   * a repeated header means is the consumer's protocol rather than this listener's.
   */
  readonly headers: IncomingHttpHeaders;
}

/**
 * A route's answer to one request: the status to write, and optionally the headers and body to write with it.
 *
 * @category Utilities
 */
export interface HttpListenerResponse {

  /**
   * The response body. Omitted for a status that carries none.
   */
  body?: Buffer | string;

  /**
   * The response headers, written alongside the status.
   */
  headers?: OutgoingHttpHeaders;

  /**
   * The status code to answer with.
   */
  status: number;
}

/**
 * A route: the function that turns one request into one answer.
 *
 * Synchronous by contract. The answer is written the moment the handler returns, so a delivery stays inside the sender's own receive budget and nothing a handler
 * started can outlive the listener. A handler with asynchronous work to do dispatches it and answers, rather than making the sender wait on it.
 *
 * @param request - The request to answer.
 *
 * @returns The answer to write.
 *
 * @category Utilities
 */
export type HttpListenerHandler = (request: HttpListenerRequest) => HttpListenerResponse;

/**
 * Per-route options for {@link HttpListener.route}.
 *
 * @category Utilities
 */
export interface HttpListenerRouteOptions {

  /**
   * The HTTP methods this route accepts, compared exactly against the request's method. Absent means every method; an empty list admits none. A request whose method
   * is absent altogether is outside any declared list.
   */
  methods?: readonly string[];
}

// One registered route: the handler and the method filter it was registered with. Held as its own record so a route's disposal handle can compare the entry it
// registered against whatever the map holds when it runs, and remove only its own.
interface HttpListenerRoute {

  readonly handler: HttpListenerHandler;
  readonly methods?: readonly string[];
}

// Render a route key for a human. An exact path is its own name; the catch-all needs the phrase that says what it claims, because a symbol renders as nothing a
// reader can act on. Shared by the collision refusal and the handler-fault line so the two name the same route the same way.
function describePath(path: HttpListenerPath): string {

  return (typeof path === "string") ? path : "every path";
}

// Refuse an option whose value cannot produce a working listener, naming the option in the refusal so a misconfiguration reads as one rather than as an unexplained
// failure later. `retry()` applies the same library-boundary check to its own `attempts`.
function assertPositive(value: number, option: string): void {

  if(!Number.isFinite(value) || (value <= 0)) {

    throw new TypeError("HttpListener: `" + option + "` must be a positive finite number.");
  }
}

/**
 * A signal-scoped HTTP listener: one `http.Server` whose lifetime is an {@link AbortSignal}, with routes registered by handle, a bounded raw-body read, a bind retry
 * that composes over the library's own `retry()` on an injected {@link Clock}, and a disposal that has released the port by the time it resolves.
 *
 * @example
 *
 * ```ts
 * import { HTTP_LISTENER_ANY_PATH, HttpListener } from "homebridge-plugin-utils";
 *
 * await using listener = new HttpListener({ label: "document server", log: this.log, port: 10110, signal: this.signal });
 *
 * // One route answering every path, which is what a server with a single document to hand out wants.
 * using _route = listener.route(HTTP_LISTENER_ANY_PATH, () => ({ body: this.document(), headers: { "Content-Type": "text/plain" }, status: 200 }));
 *
 * await listener.ready;
 * ```
 *
 * @category Utilities
 */
export class HttpListener implements AsyncDisposable {

  /**
   * The composed abort signal representing this listener's lifetime. Aborts exactly once - when {@link HttpListener.abort} is called, when the caller's signal fires,
   * or when the server fails in a way it cannot come back from; `signal.reason` names the cause.
   */
  public readonly signal: AbortSignal;

  /**
   * Resolves on the first successful bind, and rejects with `signal.reason` if the lifetime ends before one happens. Marked handled, so a consumer that never awaits
   * it - one that simply registers routes and lets the listener come up on its own - does not turn a shutdown into an unhandled rejection.
   */
  public readonly ready: Promise<void>;

  // The largest body a route will be handed, in bytes.
  readonly #bodyLimit: number;

  // Resolved by the server's own `close` callback. `[Symbol.asyncDispose]` awaits it, so `await using` truly means "the port is releasable again" by the time the
  // surrounding scope's next statement runs, rather than "teardown has been scheduled."
  readonly #closed: Promise<void>;

  // Held as a field so `#teardown` can settle it from outside the close callback's own scope.
  readonly #closedResolvers: PromiseWithResolvers<void>;

  // The caller's time source, held unresolved and handed to `retry()` so the default lives in one place rather than being resolved twice.
  readonly #clock: Clock | undefined;

  // The private controller whose signal is composed into `this.signal`. Owning it internally keeps teardown reachable from the bind task and the server's error
  // handler without handing a caller the raw controller.
  readonly #controller: AbortController;

  // The noun phrase every log line names this listener by.
  readonly #label: string;

  readonly #log: HomebridgePluginLogging;

  // The port the caller asked for, which is what every bind attempt uses. Zero asks for an ephemeral one; `boundPort` reports what the kernel gave.
  readonly #port: number;

  // Held as a field so `#teardown` can reject it, which is what settles `ready` for a lifetime that ends before a bind ever succeeds.
  readonly #readyResolvers: PromiseWithResolvers<void>;

  // The registered routes, keyed by exact path or by the catch-all sentinel.
  readonly #routes = new Map<HttpListenerPath, HttpListenerRoute>();

  readonly #retryMs: number;

  readonly #server: Server;

  /**
   * Construct and start a listener. Binding begins immediately and is retried while the port is in use, so a caller that needs to know when it came up awaits
   * {@link HttpListener.ready}.
   *
   * @param options - The listener's inputs. See {@link HttpListenerOptions}.
   *
   * @throws {TypeError} If `label` is empty, or `bodyLimit` or `retryMs` is not a positive finite number, or `port` is not an integer from 0 to 65535. Each refusal
   * names the option, so a misconfiguration is diagnosable where it was made.
   */
  public constructor(options: HttpListenerOptions) {

    const { bodyLimit = HTTP_LISTENER_BODY_LIMIT, clock, label, log, port, retryMs = HTTP_LISTENER_RETRY_MS, signal } = options;

    if(label.length === 0) {

      throw new TypeError("HttpListener: `label` must name the listener.");
    }

    assertPositive(bodyLimit, "bodyLimit");
    assertPositive(retryMs, "retryMs");

    /* The port is checked here rather than left to `listen()` because an out-of-range port is the one thing that makes `listen()` throw synchronously, and a
     * synchronous throw inside the bind task would leave the `listening` wait registered a line above it with nobody to settle it. Refusing the port at construction
     * is what lets that wait be registered without a handler of its own.
     */
    if(!Number.isInteger(port) || (port < 0) || (port > 65535)) {

      throw new TypeError("HttpListener: `port` must be an integer from 0 to 65535.");
    }

    this.#bodyLimit = bodyLimit;
    this.#clock = clock;
    this.#label = label;
    this.#log = log;
    this.#port = port;
    this.#retryMs = retryMs;

    this.#controller = new AbortController();
    this.signal = composeSignals(signal, this.#controller.signal);

    this.#readyResolvers = Promise.withResolvers();
    this.#closedResolvers = Promise.withResolvers();
    this.ready = markHandled(this.#readyResolvers.promise);
    this.#closed = this.#closedResolvers.promise;

    this.#server = createServer();

    /* Every request goes through the dispatch guard, so a fault in the serving path itself is logged once instead of becoming an unhandled rejection on a server
     * Node calls without awaiting. Everything a request can legitimately do - an unknown path, a refused method, an oversized or truncated body, a handler that
     * throws - is answered inside `#serve` and never reaches this backstop; what does reach it is a defect here.
     */
    this.#server.on("request", (request: IncomingMessage, response: ServerResponse) => {

      guardedDispatch({ handler: () => this.#serve(request, response), label: this.#label + " request", log: this.#log });
    });

    this.#server.on("error", (error: Error) => this.#onServerError(error));

    // The single teardown convergence point, whichever path ends the lifetime. `onAbort` runs it inline when the signal has already fired, which is a case this
    // genuinely reaches: a plugin configures its listener from an unawaited login that can race a shutdown.
    onAbort(this.signal, () => this.#teardown());

    // An already-aborted lifetime tore the server down inline above, on a server that never listened. There is nothing to bind.
    if(this.signal.aborted) {

      return;
    }

    this.#startBinding();
  }

  /**
   * Register a handler for one path.
   *
   * @param path    - The path to route, exactly as a sender will address it, or {@link HTTP_LISTENER_ANY_PATH} to answer every request no exact route claims.
   * @param handler - The function that answers requests to that path.
   * @param options - Optional per-route options. See {@link HttpListenerRouteOptions}.
   *
   * @returns A handle whose disposal releases the path. Disposal removes only the registration this call made, so a handle disposed after its path was registered
   *          again removes nothing.
   *
   * @throws The lifetime's abort reason if the listener has ended, and a `TypeError` naming the collision if the path is already routed.
   */
  public route(path: HttpListenerPath, handler: HttpListenerHandler, options: HttpListenerRouteOptions = {}): Disposable {

    // A verb on a dead resource answers with the reason the resource died, which is the house shape and tells a caller why rather than merely that.
    if(this.aborted) {

      throw this.signal.reason;
    }

    if(this.#routes.has(path)) {

      throw new TypeError("The HTTP listener already routes " + describePath(path) + " to another handler.");
    }

    const entry: HttpListenerRoute = { handler, methods: options.methods };

    this.#routes.set(path, entry);

    /* Disposal by identity rather than by key. A handle that outlived its registration - disposed after the path was released and claimed again - would otherwise
     * remove the live route belonging to somebody else, which is a defect the holder of the stale handle can neither see nor cause deliberately.
     */
    return { [Symbol.dispose]: (): void => {

      if(this.#routes.get(path) === entry) {

        this.#routes.delete(path);
      }
    } };
  }

  /**
   * Abort the listener and tear it down. Defaults to `HbpuAbortError("shutdown")` when no reason is supplied; explicit reasons pass through unchanged.
   *
   * Safe to call more than once: subsequent calls are no-ops because the underlying signal only aborts once.
   *
   * @param reason - Optional abort reason. Typically an {@link HbpuAbortError}; platform errors (`TimeoutError`, `AbortError`) also interoperate by convention.
   */
  public abort(reason?: unknown): void {

    if(this.aborted) {

      return;
    }

    this.#controller.abort(reason ?? new HbpuAbortError("shutdown"));
  }

  /**
   * `AsyncDisposable` implementation. Aborts the listener (defaulting to `"shutdown"`) and awaits the server's own close, so the port is bindable again by the time
   * the surrounding `await using` scope's next statement runs. An in-flight request does not delay it: teardown drops every connection.
   *
   * @returns A promise that resolves once the server has closed.
   */
  public async [Symbol.asyncDispose](): Promise<void> {

    this.abort();

    await this.#closed;
  }

  /**
   * `true` once `this.signal` has aborted. Derived from the signal; no independent state.
   */
  public get aborted(): boolean {

    return this.signal.aborted;
  }

  /**
   * The port the listener is actually bound to, or zero before it has bound one and once it has closed. A caller that asked for an ephemeral port learns here which
   * one it was given.
   */
  public get boundPort(): number {

    const address = this.#server.address();

    return ((address === null) || (typeof address === "string")) ? 0 : address.port;
  }

  // Answer one request. Every condition below is answered here rather than thrown, so the dispatch guard around this method stays a backstop for defects.
  async #serve(request: IncomingMessage, response: ServerResponse): Promise<void> {

    // The path alone, with any query string set aside: a route is registered for a path, and matching the whole request target instead would drop a sender that
    // appends something of its own into a refusal it cannot diagnose.
    const path = (request.url ?? "").split("?")[0] ?? "";

    /* An exact route is looked up first and the catch-all only after it, which is what makes an exact registration take precedence over a route claiming everything.
     * The key is kept alongside the entry because the fault line below names the route that failed, and for the catch-all that is not the request's own path.
     */
    const exact = this.#routes.get(path);
    const key: HttpListenerPath = (exact === undefined) ? HTTP_LISTENER_ANY_PATH : path;
    const route = exact ?? this.#routes.get(HTTP_LISTENER_ANY_PATH);

    // Nothing claims this path. The body is never read: there is nobody to hand it to.
    if(route === undefined) {

      response.writeHead(404).end();

      return;
    }

    /* The method filter answers before the body is read, so a request a route would refuse on its method costs nothing to refuse however large its body is. A
     * request carrying no method at all is outside any declared list, since a list names the methods it admits rather than the ones it excludes.
     */
    if((route.methods !== undefined) && !route.methods.includes(request.method ?? "")) {

      response.writeHead(405).end();

      return;
    }

    const chunks: Buffer[] = [];
    let length = 0;

    try {

      // `IncomingMessage` is a `Readable`, whose ambient async iterator is declared to yield `any`. Naming the source as an iterable of buffers is what types
      // `chunk` without a cast, and the runtime yields buffers because a request stream is never in object mode.
      const body: AsyncIterable<Buffer> = request;

      for await (const chunk of body) {

        length += chunk.length;

        if(length > this.#bodyLimit) {

          /* The socket is taken before the refusal is written, because a finished response detaches the request from it and the callback below would find nothing
           * left to drop.
           */
          const socket = request.socket;

          response.writeHead(413);

          /* The socket is dropped only once the refusal has flushed, so a client still writing reads why it was refused rather than seeing a bare reset. The rest of
           * a body already known to be unusable is not worth draining.
           */
          response.end(() => socket.destroy());

          return;
        }

        chunks.push(chunk);
      }
    } catch {

      /* A request stream that ends before its body does - a client that reset the connection, or a teardown dropping the socket mid-upload - is answered with
       * nothing at all and says nothing. The peer is untrusted, and anything that can be made to happen at will must not be able to write into the log at will.
       */
      return;
    }

    let answer: HttpListenerResponse;

    try {

      answer = route.handler({ body: Buffer.concat(chunks), headers: request.headers });
    } catch(error: unknown) {

      /* A fault inside one route is that route's alone. The sender is told the request failed rather than that it was refused, because those mean different things
       * to whatever is retrying on the other end.
       */
      this.#log.error("The %s handler for %s failed: %s.", this.#label, describePath(key), formatErrorMessage(error));
      response.writeHead(500).end();

      return;
    }

    response.writeHead(answer.status, answer.headers);
    response.end(answer.body);
  }

  // The server's own error channel. A bind failure reaches the retry through the `listening` wait instead, so this handler declines it.
  #onServerError(error: Error): void {

    /* Two errors this handler is not the owner of. A lifetime that has already ended has its reason recorded, and a later, vaguer one must not overwrite it. An error
     * on a server that is not listening is a bind failure, which the wait in `#bind` already carries into the retry - and between attempts the server holds no
     * handle, so it has no error source of its own for this handler to be the second owner of.
     */
    if(this.aborted || !this.#server.listening) {

      return;
    }

    this.#log.error("The %s encountered an error and has stopped: %s.", this.#label, formatErrorMessage(error));
    this.#controller.abort(new HbpuAbortError("failed", { cause: error }));
  }

  // Start the detached bind task: retry the bind for as long as the lifetime lasts, announce the port, and settle `ready`.
  #startBinding(): void {

    /* `superviseLoop` is the envelope: it swallows the unwinding when the signal has aborted - the teardown owns that path and has already rejected `ready` - and
     * surfaces a genuine failure through `onError` exactly once, never rejecting, so the detached task cannot float a rejection.
     */
    void superviseLoop({

      loop: async (signal: AbortSignal): Promise<void> => {

        /* The retry loop itself is `retry()`, not a timer of this class's own: it owns the attempt loop, the backoff wait on the injected clock, and the
         * normalization of any rejection that coincides with an abort back into the signal's reason. A port in use is the one failure worth waiting out, so it is
         * the only one `shouldRetry` admits; anything else stops the loop and reaches `onError` below.
         */
        await retry((attemptSignal: AbortSignal) => this.#bind(attemptSignal), { attempts: Infinity, backoff: (): number => this.#retryMs, clock: this.#clock,
          shouldRetry: (error: unknown): boolean => hasErrorCode(error, "EADDRINUSE"), signal });

        // The kernel's port rather than the configured one, so a listener that asked for an ephemeral port reports what it was given.
        this.#log.info("The %s is listening on port %d.", this.#label, this.boundPort);
        this.#readyResolvers.resolve();
      },
      onError: (error: unknown): void => {

        this.#log.error("The %s could not start: %s.", this.#label, formatErrorMessage(error));
        this.#controller.abort(new HbpuAbortError("failed", { cause: error }));
      },
      signal: this.signal
    });
  }

  // One bind attempt, resolving when the server is listening and rejecting with the kernel's error when it is not.
  async #bind(signal: AbortSignal): Promise<void> {

    /* `retry()` checks the signal once before its loop rather than before each attempt, so an abort that lands while a backoff wait is settling would otherwise let
     * the attempt after it bind a server the teardown has already closed. Checking here is what closes that window.
     */
    signal.throwIfAborted();

    // The wait is registered before the bind is asked for, so an outcome that arrives in the same turn as the request has a listener waiting for it. `events.once`
    // settles on the server's own `error` event too, which is how a failed bind arrives here as a rejection carrying the kernel's error.
    const listening = once(this.#server, "listening", { signal });

    this.#server.listen(this.#port);

    try {

      await listening;
    } catch(error: unknown) {

      // A held port is reported on each attempt, because a port held for a long time should say so rather than going quiet after the first try. Any other failure is
      // reported once by `onError`, so it is not named twice here.
      if(hasErrorCode(error, "EADDRINUSE")) {

        this.#log.error("The port the %s needs is in use by another process. Retrying in %s.", this.#label, formatMs(this.#retryMs));
      }

      throw error;
    }
  }

  /* Teardown convergence point, run exactly once when `this.signal` aborts. Clearing the routes releases every consumer closure a disposed listener would otherwise
   * hold; dropping the connections is what makes the port releasable at once rather than whenever the peers happen to let go; and rejecting `ready` is inert when a
   * bind already resolved it, so the one call covers both a lifetime that ended before the listener came up and one that ended after.
   */
  #teardown(): void {

    this.#routes.clear();
    this.#server.closeAllConnections();
    this.#server.close(() => this.#closedResolvers.resolve());
    this.#readyResolvers.reject(this.signal.reason);
  }
}
