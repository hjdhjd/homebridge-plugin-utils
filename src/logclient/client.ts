/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * logclient/client.ts: AsyncDisposable Homebridge UI log client composing the auth, REST, socket, parser, and stitch transports into history/follow/tail streams.
 */

/**
 * AsyncDisposable client for the Homebridge UI log stream.
 *
 * {@link HomebridgeLogClient} is the subsystem-local composition root: it holds the connection configuration and the credentials, and it composes the pure leaf modules
 * (`parser.ts`, `stitch.ts`) with the three transports (`auth.ts`, `rest.ts`, `socket.ts`) into three consumer-facing channels, each returning a {@link LogStream}:
 *
 * - {@link HomebridgeLogClient.history} - a one-shot REST whole-file download parsed into records, optionally trimmed to the most recent N lines.
 * - {@link HomebridgeLogClient.follow} - a live socket tail: the server's ~500-line seed followed by genuinely new lines, streamed indefinitely.
 * - {@link HomebridgeLogClient.tail} - a {@link TailRequest}-driven dispatcher that selects `history`, `follow`, or the socket-first `follow-history` join.
 *
 * Two design points are load-bearing:
 *
 * - **Token lifecycle via a closure.** The client builds one {@link TokenProvider} closure over {@link acquireToken} and the stored credentials. The socket invokes it on
 *   every connect attempt, so a `password`/`noauth` credential re-authenticates from the stored credentials on each reconnect (surviving token expiry across a drop). A
 *   static `token` credential is returned verbatim with no network call, so it is never "refreshed"; an expired static token instead surfaces later when the socket
 *   handshake is rejected.
 * - **Leak-free per-call teardown.** Each channel is an async generator wrapper, mirroring `mp4-assembler.ts`. It builds a per-call {@link LogSocketLike} through the
 *   injected {@link LogSocketFactory} seam under a per-call abort controller composed with the client's lifetime, and its `finally` disposes that socket and aborts the
 *   per-call controller. Both `await using stream = client.follow()` and an early `break` out of the iteration therefore tear the per-call socket down with no leak.
 *
 * Lifetime is a composed {@link AbortSignal}: the optional caller `signal` composed with the client's own controller. Disposing the client (or aborting the caller
 * signal) aborts every in-flight channel, because each channel composes its per-call signal under the client's lifetime signal.
 *
 * @module
 */
import { DEFAULT_HOST, DEFAULT_PORT } from "./settings.ts";
import { HbpuAbortError, composeSignals, noOpLog, takeLast } from "../util.ts";
import type { LogClientCredentials, LogQuantity, LogRecord, TailRequest } from "./types.ts";
import type { LogSocketFactory, LogSocketLike, TokenProvider } from "./socket.ts";
import type { HomebridgePluginLogging } from "../util.ts";
import { acquireToken } from "./auth.ts";
import { downloadLog } from "./rest.ts";
import { logSocketFactory } from "./socket.ts";
import { parseLogLine } from "./parser.ts";
import { stitchLive } from "./stitch.ts";

/**
 * A consumer-facing log stream: an async iterable of parsed {@link LogRecord}s that is also {@link AsyncDisposable}.
 *
 * Every {@link HomebridgeLogClient} channel returns one. Iterate it with `for await (const record of stream)`; dispose it with `await using stream = client.follow()` (or
 * an early `break`) to tear down the underlying transport with no leak. The two super-interfaces capture exactly that contract: it is iterable, and it cleans up after
 * itself when the scope exits. A plain async generator satisfies it structurally - its `[Symbol.asyncIterator]` makes it iterable and its `[Symbol.asyncDispose]` (which
 * delegates to the generator's `return()`, running the `finally` that disposes the per-call socket) makes it disposable.
 *
 * @category Log Client
 */
export interface LogStream extends AsyncIterable<LogRecord>, AsyncDisposable {}

/**
 * Construction-time options for {@link HomebridgeLogClient}.
 *
 * @property credentials   - The credentials used to authenticate. See {@link LogClientCredentials}.
 * @property fetch         - Optional `fetch` implementation for the auth and REST transports. Defaults to the global `fetch`. Injected so the client is testable without
 *                           a live server.
 * @property host          - The hostname or IP of the homebridge-config-ui-x server. Defaults to `localhost`.
 * @property log           - Optional logger for connection lifecycle and diagnostics. Defaults to a silent no-op sink when omitted.
 * @property port          - The TCP port the server listens on. Defaults to `8581`.
 * @property signal        - Optional parent {@link AbortSignal} composed with the client's internal controller. When it aborts, every in-flight channel tears down.
 * @property socketFactory - Optional factory seam for constructing the live-log socket. Defaults to {@link logSocketFactory}. Injected so the client is testable without
 *                           a WebSocket.
 * @property tls           - When `true`, use the secure (`https`/`wss`) schemes; when `false` or omitted, plaintext (`http`/`ws`).
 *
 * @category Log Client
 */
export interface HomebridgeLogClientOptions {

  readonly credentials: LogClientCredentials;
  readonly fetch?: typeof fetch;
  readonly host?: string;
  readonly log?: HomebridgePluginLogging;
  readonly port?: number;
  readonly signal?: AbortSignal;
  readonly socketFactory?: LogSocketFactory;
  readonly tls?: boolean;
}

/**
 * AsyncDisposable client for the Homebridge UI log stream.
 *
 * @example
 *
 * ```ts
 * import { HomebridgeLogClient } from "homebridge-plugin-utils";
 *
 * await using client = new HomebridgeLogClient({ credentials: { kind: "password", password: "secret", username: "admin" }, host: "localhost" });
 *
 * await using stream = client.tail({ mode: "follow-history", quantity: 200 });
 *
 * for await (const record of stream) {
 *
 *   process.stdout.write(record.raw + "\n");
 * }
 * ```
 *
 * @category Log Client
 */
export class HomebridgeLogClient implements AsyncDisposable {

  /**
   * The composed abort signal representing this client's lifetime. Aborts exactly once - when the client is disposed (`[Symbol.asyncDispose]`) or the parent
   * signal fires - and `signal.reason` names the cause. Every channel composes its per-call signal under this one, so disposing the client tears down all in-flight
   * channels.
   */
  public readonly signal: AbortSignal;

  // The private controller whose signal is composed into `this.signal`. Owned internally so the only teardown verb is disposal.
  readonly #controller: AbortController;

  readonly #credentials: LogClientCredentials;
  readonly #fetch: typeof fetch | undefined;
  readonly #host: string;
  readonly #log: HomebridgePluginLogging;
  readonly #port: number;

  // Whether the configured credential can mint a fresh token on a reconnect. A `password`/`noauth` credential re-authenticates from the stored credentials on each
  // connect (refreshable); a static `token` is returned verbatim with nothing to refresh. Derived once at construction and handed to every per-call socket so a handshake
  // auth rejection is classified terminal for a static token (fail fast) and retryable for refreshable credentials (the next attempt re-auths).
  readonly #refreshable: boolean;

  readonly #socketFactory: LogSocketFactory;
  readonly #tls: boolean;

  // The single token provider closure, built once at construction over the stored credentials. The socket invokes it on every connect attempt; `history()` invokes it
  // once before the REST download. A `password`/`noauth` credential re-authenticates from the stored credentials on each call (surviving expiry across a reconnect); a
  // static `token` is returned verbatim by `acquireToken` with no network call, so it is implicitly never refreshed.
  readonly #tokenProvider: TokenProvider;

  /**
   * Construct a new log client.
   *
   * Construction performs no I/O: no connection is opened and no token is acquired until a channel is invoked. The token provider closure is built here so every channel
   * shares one authentication path.
   *
   * @param options - Required options. See {@link HomebridgeLogClientOptions}.
   */
  public constructor(options: HomebridgeLogClientOptions) {

    this.#credentials = options.credentials;
    this.#fetch = options.fetch;
    this.#host = options.host ?? DEFAULT_HOST;
    this.#log = options.log ?? noOpLog;
    this.#port = options.port ?? DEFAULT_PORT;

    // A static `token` credential has nothing to re-acquire, so it is non-refreshable; the other credential arms (`password`, `noauth`) re-authenticate on each connect.
    this.#refreshable = options.credentials.kind !== "token";

    this.#socketFactory = options.socketFactory ?? logSocketFactory;
    this.#tls = options.tls ?? false;

    this.#controller = new AbortController();
    this.signal = composeSignals(options.signal, this.#controller.signal);

    // Build the token provider once. The `signal` parameter is part of the `TokenProvider` contract (the socket forwards each connect attempt's signal so an in-flight
    // acquisition can be cancelled), but `acquireToken` exposes no signal seam of its own today, so the closure does not forward it - hence the underscore prefix. Each
    // invocation re-derives the token from the stored credentials, which is exactly the "re-auth on reconnect for password/noauth, return-verbatim for token" behavior
    // the token lifecycle requires.
    this.#tokenProvider = (_signal: AbortSignal): Promise<string> => acquireToken(this.#credentials, { fetch: this.#fetch, host: this.#host, port: this.#port,
      tls: this.#tls });
  }

  /**
   * `AsyncDisposable` implementation. Aborts the client (defaulting to `"shutdown"`), which aborts every in-flight channel's per-call signal, so callers using
   * `await using` are guaranteed all channels have begun tearing down by the time the block exits.
   *
   * @returns A resolved promise once the abort has been issued.
   */
  public async [Symbol.asyncDispose](): Promise<void> {

    if(!this.signal.aborted) {

      this.#controller.abort(new HbpuAbortError("shutdown"));
    }
  }

  /**
   * `true` once `this.signal` has aborted. Derived from the signal; no independent state.
   */
  public get aborted(): boolean {

    return this.signal.aborted;
  }

  /**
   * Retrieve historical log lines over the REST whole-file download channel.
   *
   * Streams `GET .../log/download` through the parser and yields each parsed {@link LogRecord}. When `quantity` is a number, only the most recent N records are retained
   * (via {@link takeLast}, a bounded ring so a multi-MB log is never fully materialized); when it is `"all"` (the default), every record passes through. This is the
   * deep-history channel paid only when the caller explicitly wants history beyond the socket's ~500-line seed.
   *
   * @param options          - Optional per-call options.
   * @param options.quantity - How many of the most recent records to retain. Defaults to `"all"`.
   * @param options.signal   - Optional per-call abort signal composed with the client's lifetime; aborting it terminates only this stream.
   *
   * @returns A {@link LogStream} of historical records, oldest first.
   */
  public history(options: { quantity?: LogQuantity; signal?: AbortSignal } = {}): LogStream {

    const quantity = options.quantity ?? "all";

    return this.#stream(options.signal, async function *(this: HomebridgeLogClient, callSignal: AbortSignal): AsyncGenerator<LogRecord> {

      yield* this.#history(quantity, callSignal);
    });
  }

  /**
   * Live-tail the log over the socket channel.
   *
   * Builds a {@link LogSocketLike} through the injected factory seam and yields each parsed {@link LogRecord} the server streams - the ~500-line seed first, then
   * genuinely new lines indefinitely. The stream terminates only when the caller stops iterating (an early `break`, which disposes the socket), the per-call signal
   * aborts, or the client is disposed.
   *
   * @param options        - Optional per-call options.
   * @param options.signal - Optional per-call abort signal composed with the client's lifetime; aborting it terminates only this stream.
   *
   * @returns A {@link LogStream} of live records.
   */
  public follow(options: { signal?: AbortSignal } = {}): LogStream {

    return this.#stream(options.signal, async function *(this: HomebridgeLogClient, callSignal: AbortSignal): AsyncGenerator<LogRecord> {

      yield* this.#follow(callSignal);
    });
  }

  /**
   * Deliver log content over the channel selected by the {@link TailRequest} discriminated union.
   *
   * - `history` - delegates to {@link HomebridgeLogClient.history} with the request's quantity.
   * - `follow` - delegates to {@link HomebridgeLogClient.follow}.
   * - `follow-history` - the socket-first join: the socket connects and buffers its seed plus any live lines that arrive during the REST download into a bounded ring,
   *   then the REST history is downloaded and trimmed to the request's quantity, then the two are joined by {@link stitchLive} so the boundary overlap is removed without
   *   dropping a distinct live line, and finally the live stream continues. Connecting the socket first is what guarantees no live line produced during the download is
   *   lost.
   *
   * @param request        - The request describing which content to deliver and over which channel. See {@link TailRequest}.
   * @param options        - Optional per-call options.
   * @param options.signal - Optional per-call abort signal composed with the client's lifetime; aborting it terminates only this stream.
   *
   * @returns A {@link LogStream} for the selected channel.
   */
  public tail(request: TailRequest, options: { signal?: AbortSignal } = {}): LogStream {

    switch(request.mode) {

      case "follow": {

        return this.follow(options);
      }

      case "follow-history": {

        return this.#stream(options.signal, async function *(this: HomebridgeLogClient, callSignal: AbortSignal): AsyncGenerator<LogRecord> {

          yield* this.#followHistory(request.quantity, callSignal);
        });
      }

      case "history": {

        return this.history({ quantity: request.quantity, signal: options.signal });
      }

      default: {

        // The union is exhausted above; this satisfies exhaustiveness and guards against a future mode being added without a handler here.
        throw new Error("Unsupported tail request mode.");
      }
    }
  }

  // Build a per-call abort controller composed with the client's lifetime and the caller's optional signal, then run `body` as the channel generator. The returned async
  // generator is the `LogStream`: its `finally` aborts the per-call controller, so disposal (or an early `break`, which calls the generator's `return()`) tears the call
  // down. Each channel body builds its own socket under `callSignal` and disposes it in its own `finally`; aborting the per-call controller here is the belt-and-braces
  // upper bound that also unwinds a channel body that parked on a wait rather than on the socket. `body` is bound to `this` so the channel implementations read the
  // client's private fields directly.
  async *#stream(callerSignal: AbortSignal | undefined,
    body: (this: HomebridgeLogClient, callSignal: AbortSignal) => AsyncGenerator<LogRecord>): AsyncGenerator<LogRecord> {

    const callController = new AbortController();
    const callSignal = composeSignals(this.signal, callerSignal, callController.signal);

    try {

      yield* body.call(this, callSignal);
    } finally {

      // Abort the per-call controller on every exit path - normal completion, an early `break` (the generator's `return()` runs this `finally`), a thrown error, or
      // client disposal. The channel body's own `finally` has already disposed its socket; this guarantees the per-call signal is settled regardless.
      callController.abort(new HbpuAbortError("shutdown"));
    }
  }

  // History channel implementation. Acquires a token, streams the REST whole-file download through the parser, and yields the records - all of them for `"all"`, or only
  // the most recent N (via the bounded `takeLast` ring) for a numeric quantity. Shared by `history()` and by `tail()`'s `history` mode.
  async *#history(quantity: LogQuantity, callSignal: AbortSignal): AsyncGenerator<LogRecord> {

    const records = this.#downloadRecords(callSignal);

    if(typeof quantity === "number") {

      // Retain only the most recent N records. `takeLast` drains the source into a fixed-capacity ring, so even a multi-MB history never grows the working set beyond N.
      for(const record of await takeLast(records, quantity)) {

        yield record;
      }

      return;
    }

    // `"all"` - pass every record through in file order.
    yield* records;
  }

  // Follow channel implementation. Builds a per-call socket through the factory seam and yields each parsed line. The socket is disposed in the `finally` so an early
  // `break` or client disposal tears it down leak-free, mirroring the `await using` discipline `mp4-assembler.ts` relies on for its source.
  async *#follow(callSignal: AbortSignal): AsyncGenerator<LogRecord> {

    const socket = this.#createSocket(callSignal);

    try {

      for await (const line of socket.stdout()) {

        yield parseLogLine(line);
      }
    } finally {

      // Dispose the per-call socket on every exit path. Disposal aborts the socket and awaits its reconnect loop, so the WebSocket is closed by the time this returns.
      await socket[Symbol.asyncDispose]();
    }
  }

  // Follow-history channel implementation - the socket-first join. The socket connects first (so no live line produced during the REST download is lost) and its seed
  // plus any live lines that arrive during the download are buffered into a bounded ring; the REST history is downloaded and trimmed to `quantity`; the two are joined by
  // `stitchLive` (minimal overlap, so no distinct live line is dropped); the stitched result is yielded; then the live stream continues. A single in-flight live pull is
  // carried across the stitch boundary so a line that was requested-but-not-yet-arrived when the download finished becomes the first live-continuation line rather than
  // being lost or double-counted.
  async *#followHistory(quantity: LogQuantity, callSignal: AbortSignal): AsyncGenerator<LogRecord> {

    const socket = this.#createSocket(callSignal);

    try {

      // The single live iterator. The class is single-consumer, so exactly one iterator is pulled - here and, after the stitch, for the live continuation. We hold the
      // in-flight `next()` promise across the buffering loop so the pull that is outstanding when history finishes is not discarded.
      const liveIterator = socket.stdout()[Symbol.asyncIterator]();

      // Start the REST history download in parallel with buffering the socket's seed-plus-live. Trimming to `quantity` happens inside so the resolved value is already
      // the history tail to stitch against. The promise is observed below; until then it runs concurrently with the buffering race.
      const historyPromise = this.#collectHistory(quantity, callSignal);

      // Buffer the socket's seed plus any live lines that arrive while history downloads, into an ordered list. We race the outstanding live pull against the history
      // download: each time the live pull resolves first, we record the line and issue the next pull; when the download resolves first, we stop buffering and carry the
      // still-outstanding live pull forward as the first continuation pull.
      const bufferedLive: LogRecord[] = [];
      let pendingNext = liveIterator.next();
      let liveDone = false;
      const historyMarker = historyPromise.then((): "history" => "history");

      for(;;) {

        // eslint-disable-next-line no-await-in-loop
        const winner = await Promise.race([ pendingNext.then((): "live" => "live"), historyMarker ]);

        if(winner === "history") {

          // History finished first. Stop buffering; `pendingNext` may still be outstanding and is carried into the continuation phase below.
          break;
        }

        // eslint-disable-next-line no-await-in-loop
        const result = await pendingNext;

        if(result.done) {

          // The socket ended before history finished (an abort or a terminal failure). There is no more live to buffer or continue.
          liveDone = true;

          break;
        }

        bufferedLive.push(parseLogLine(result.value));
        pendingNext = liveIterator.next();
      }

      // Join history and the buffered live at their minimal overlap, then yield the stitched result. `stitchLive` never drops a distinct live line; it may emit a bounded
      // run of duplicates or a visible gap marker when no overlap is found.
      const history = await historyPromise;

      for(const record of stitchLive(history, bufferedLive)) {

        yield record;
      }

      // Live continuation. First drain the pull that was outstanding when history finished (so the in-flight line is not lost), then continue pulling the live stream
      // until it ends or the call is torn down.
      if(!liveDone) {

        const result = await pendingNext;

        if(!result.done) {

          yield parseLogLine(result.value);

          for(;;) {

            // eslint-disable-next-line no-await-in-loop
            const next = await liveIterator.next();

            if(next.done) {

              break;
            }

            yield parseLogLine(next.value);
          }
        }
      }
    } finally {

      // Dispose the per-call socket on every exit path, exactly as the simple follow channel does.
      await socket[Symbol.asyncDispose]();
    }
  }

  // Collect the REST history into the tail to stitch against: the most recent N records for a numeric quantity (via the bounded `takeLast` ring), or every record for
  // `"all"`. Returns a materialized array because the stitch needs random access to history's trailing window. For `"all"` the array is the whole file, which is the cost
  // the caller accepted by asking for all of history.
  async #collectHistory(quantity: LogQuantity, callSignal: AbortSignal): Promise<LogRecord[]> {

    const records = this.#downloadRecords(callSignal);

    if(typeof quantity === "number") {

      return takeLast(records, quantity);
    }

    const all: LogRecord[] = [];

    for await (const record of records) {

      all.push(record);
    }

    return all;
  }

  // Acquire a token and stream the REST whole-file download through the parser, yielding each parsed record. The shared REST-to-records pipeline for both history paths.
  async *#downloadRecords(callSignal: AbortSignal): AsyncGenerator<LogRecord> {

    const token = await this.#tokenProvider(callSignal);

    for await (const line of downloadLog({ fetch: this.#fetch, host: this.#host, port: this.#port, tls: this.#tls, token })) {

      yield parseLogLine(line);
    }
  }

  // Construct a per-call live-log socket through the injected factory seam, wired with the client's connection target, the shared token provider, and the per-call signal
  // so the socket's lifetime is bounded by the call's. Routing construction through the seam (rather than `new LogSocket(...)`) is what lets a test substitute a fake
  // socket and exercise the client without a WebSocket. `refreshable` is derived from the credential DU once at construction (a `password`/`noauth` credential re-
  // authenticates on each connect, so a handshake rejection is transient; a static `token` cannot be refreshed, so a handshake rejection is permanent and the socket
  // fails fast instead of retrying the same doomed token forever).
  #createSocket(callSignal: AbortSignal): LogSocketLike {

    return this.#socketFactory.create({ host: this.#host, log: this.#log, port: this.#port, refreshable: this.#refreshable, signal: callSignal, tls: this.#tls,
      tokenProvider: this.#tokenProvider });
  }
}
