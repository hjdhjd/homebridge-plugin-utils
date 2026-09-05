/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * http-listener-double.ts: A socket-free HttpListener test double - the route table and the delivery verdict, with no server behind them.
 */

/**
 * A socket-free {@link http-listener!HttpListener | HttpListener} test double.
 *
 * A plugin that hosts an HTTP surface registers routes and answers requests, and what its tests need to assert is that half: which paths it claimed, with which
 * method filters, and what its handler answers when a request arrives. This module ships the double for it - a {@link TestHttpListener} that records the routes and
 * hands a test {@link TestHttpListener.deliver} to run one through the listener's own matching rules, with no port, no kernel, and no `node:http`.
 *
 * The double stands in for the listener, it does not reimplement a server. What it mirrors is the observable contract a consumer branches on: the lifetime signal and
 * the abort reason a verb on a dead listener throws, the duplicate-path refusal, the disposal that removes only its own registration, the release of every route at
 * teardown, and the matching a delivery meets - an exact route ahead of the catch-all, 404 for a path nothing claims, 405 for a method a route's filter excludes.
 * What stays with the real class and its suite is everything the wire owns: the bounded body read and its 413, the client resets and the connection drops at
 * teardown, and the translation of a handler fault into a logged line and a 500. A handler that throws propagates straight out of `deliver`, because a test wants
 * its own fault in hand rather than a status standing in for it.
 *
 * Signatures come from the listener's own exported types, imported for their types alone, so a method here cannot drift from the method it stands in for without the
 * compiler saying so. That type-only edge is also what keeps this module free of `node:http`: a consumer's test loads the double without loading a server.
 *
 * @module
 */
import { HbpuAbortError, composeSignals, markHandled, onAbort } from "./util.ts";
import type { HttpListenerHandler, HttpListenerPath, HttpListenerRequest, HttpListenerResponse, HttpListenerRouteOptions } from "./http-listener.ts";

// Render a route key for a human, matching the wording the real class refuses a collision with. Spelled here rather than shared, because sharing it would mean a
// value import of the production module and every consumer's test would load `node:http` to use this double.
function describePath(path: HttpListenerPath): string {

  return (typeof path === "string") ? path : "every path";
}

/**
 * One recorded route, as the consumer registered it.
 *
 * @property handler - The handler exactly as the caller registered it, so a test can read it or run it directly.
 * @property methods - The method filter the route was registered with, and `undefined` for a route that accepts every method.
 *
 * @category Testing
 */
export interface TestHttpListenerRoute {

  readonly handler: HttpListenerHandler;
  readonly methods?: readonly string[];
}

/**
 * A socket-free {@link http-listener!HttpListener | HttpListener} double: it records what a consumer routed and answers a delivery from that table alone.
 *
 * @example
 *
 * ```ts
 * import { TestHttpListener } from "homebridge-plugin-utils/testing";
 *
 * const listener = new TestHttpListener({ port: 10110 });
 *
 * // The consumer registers its routes against the double, cast at its injection site. The two classes carry private fields, so nothing structural assigns one to
 * // the other and the cast is the injection point's own statement that the double stands in for the listener.
 * plugin.configureListener(listener as unknown as HttpListener);
 *
 * // Run the registered handler by hand: no port, no wire. The answer is the one the consumer's sender would read.
 * assert.equal(listener.deliver("/events", { body: Buffer.from("{}"), headers: {} }).status, 200);
 * ```
 *
 * @category Testing
 */
export class TestHttpListener implements AsyncDisposable {

  /**
   * The abort signal representing this double's lifetime, mirroring {@link http-listener!HttpListener.signal | HttpListener.signal}. It aborts exactly once - when
   * {@link TestHttpListener.abort} is called, when the caller's signal fires, or when the double is disposed.
   */
  public readonly signal: AbortSignal;

  /**
   * Mirrors {@link http-listener!HttpListener.ready | HttpListener.ready}, and marked handled as that one is. A double is bound the moment it exists, so this
   * resolves on construction; a double built over a lifetime that had already ended rejects with that lifetime's reason, exactly as the real class does when it
   * never gets to call `listen()`.
   */
  public readonly ready: Promise<void>;

  /**
   * The routes currently registered, keyed by exact path or by the catch-all sentinel - the wiring view a test asserts through. It is the same store
   * {@link TestHttpListener.deliver} matches against, so what a test reads and what a delivery meets cannot disagree. Registrations leave it when their handle is
   * disposed and when the double aborts.
   */
  public readonly routes: ReadonlyMap<HttpListenerPath, TestHttpListenerRoute>;

  // The controller whose signal is this double's lifetime. Owned privately so `abort()` is the only way to fire it, exactly as the real class owns its own.
  readonly #controller = new AbortController();

  // The one route store, exposed read-only as `routes`.
  readonly #routes = new Map<HttpListenerPath, TestHttpListenerRoute>();

  // The port this double reports as bound. There is no kernel to ask, so a test that reads `boundPort` supplies a nonzero one.
  readonly #port: number;

  /**
   * Construct a double.
   *
   * @param options        - Optional construction options.
   * @param options.port   - The port {@link TestHttpListener.boundPort} reports while the double is live. Defaults to 0, which is what the real class reports before
   *                         it has bound anything, so a test that asserts on a port passes one of its own.
   * @param options.signal - The caller's lifetime, composed into {@link TestHttpListener.signal}, mirroring the real class's own composition.
   */
  public constructor({ port = 0, signal }: { port?: number; signal?: AbortSignal } = {}) {

    this.#port = port;
    this.signal = composeSignals(signal, this.#controller.signal);

    const readyResolvers: PromiseWithResolvers<void> = Promise.withResolvers();

    this.ready = markHandled(readyResolvers.promise);
    this.routes = this.#routes;

    // The teardown convergence point, mirroring the real class's: every route is released, and `ready` is rejected. The rejection is inert once construction has
    // resolved it, which is what lets one call settle both a lifetime that ended after the double came up and one that had ended before it was built.
    onAbort(this.signal, () => {

      this.#routes.clear();
      readyResolvers.reject(this.signal.reason);
    });

    // A double binds the moment it exists: there is no kernel to wait on. A lifetime that had already ended binds nothing, exactly as the real class never calls
    // `listen()` on a signal that has already fired, and the teardown above has settled `ready` for it.
    if(!this.signal.aborted) {

      readyResolvers.resolve();
    }
  }

  /**
   * Register a handler for one path, mirroring {@link http-listener!HttpListener.route | HttpListener.route} including both of its refusals.
   *
   * @param path    - The path to route, or the catch-all sentinel.
   * @param handler - The function that answers requests to that path.
   * @param options - Optional per-route options.
   *
   * @returns A handle whose disposal releases the path, removing only the registration this call made.
   *
   * @throws The lifetime's abort reason if the double has ended, and a `TypeError` naming the collision if the path is already routed.
   */
  public route(path: HttpListenerPath, handler: HttpListenerHandler, options: HttpListenerRouteOptions = {}): Disposable {

    if(this.aborted) {

      throw this.signal.reason;
    }

    if(this.#routes.has(path)) {

      throw new TypeError("The HTTP listener already routes " + describePath(path) + " to another handler.");
    }

    const entry: TestHttpListenerRoute = { handler, methods: options.methods };

    this.#routes.set(path, entry);

    // Disposal by identity, as the real class does: a handle that outlived its registration removes nothing rather than removing somebody else's live route.
    return { [Symbol.dispose]: (): void => {

      if(this.#routes.get(path) === entry) {

        this.#routes.delete(path);
      }
    } };
  }

  /**
   * Answer one delivery from the route table, exactly as the real serve path would: an exact route takes precedence over the catch-all, a path nothing claims is a
   * 404, and a method the matched route's filter excludes is a 405. Anything else is the matched handler's own answer, and a handler that throws propagates out of
   * this call rather than becoming the 500 the real class logs and writes.
   *
   * @param path    - The path the delivery is addressed to.
   * @param request - The request to hand the matched handler.
   * @param method  - The delivery's HTTP method, compared against the matched route's filter. Defaults to `"POST"`.
   *
   * @returns The status the consumer's sender would read, and the handler's own answer when one ran.
   */
  public deliver(path: HttpListenerPath, request: HttpListenerRequest, method = "POST"): HttpListenerResponse {

    const route = this.#routes.get(path) ?? this.#catchAll();

    if(route === undefined) {

      return { status: 404 };
    }

    if((route.methods !== undefined) && !route.methods.includes(method)) {

      return { status: 405 };
    }

    return route.handler(request);
  }

  /**
   * Abort the double, mirroring {@link http-listener!HttpListener.abort | HttpListener.abort}: it defaults to `HbpuAbortError("shutdown")` when no reason is
   * supplied, and explicit reasons pass through unchanged. Safe to call more than once. Afterwards every route is released and `route()` refuses.
   *
   * @param reason - Optional abort reason. See {@link HbpuAbortError}.
   */
  public abort(reason?: unknown): void {

    if(this.aborted) {

      return;
    }

    this.#controller.abort(reason ?? new HbpuAbortError("shutdown"));
  }

  /**
   * `AsyncDisposable` implementation, mirroring the real class's: it aborts the double, defaulting to `"shutdown"`. There is no socket to wait on, so it resolves
   * once the abort has run - which is what the real class's own await amounts to by the time its server has closed.
   *
   * @returns A promise that resolves once the abort has run.
   */
  public async [Symbol.asyncDispose](): Promise<void> {

    this.abort();
  }

  /**
   * `true` once `this.signal` has aborted. Derived from the signal; no independent state.
   */
  public get aborted(): boolean {

    return this.signal.aborted;
  }

  /**
   * The port this double reports as bound: the constructed one while it is live, and zero once it has aborted, which is what the real class reports once its server
   * has closed.
   */
  public get boundPort(): number {

    return this.aborted ? 0 : this.#port;
  }

  // The catch-all entry, found by the one property that tells it apart without naming the sentinel: an exact path is always a string, so the entry under a key that
  // is not one is the catch-all. Finding it this way is what keeps this module's edge to the production module type-only.
  #catchAll(): TestHttpListenerRoute | undefined {

    for(const [ key, entry ] of this.#routes) {

      if(typeof key !== "string") {

        return entry;
      }
    }

    return undefined;
  }
}
