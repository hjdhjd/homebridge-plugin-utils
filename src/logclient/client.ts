/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * logclient/client.ts: AsyncDisposable Homebridge UI log client composing the auth, REST, socket, parser, and stitch transports into history/follow/tail streams.
 */

/**
 * AsyncDisposable client for the Homebridge UI log stream.
 *
 * {@link HomebridgeLogClient} is the subsystem-local composition root: it holds the connection configuration and the credentials, and it composes the pure leaf modules
 * (`parser.ts`, `stitch.ts`, `time-window.ts`) with the three transports (`auth.ts`, `rest.ts`, `socket.ts`) into three consumer-facing channels, each returning a
 * {@link LogStream}:
 *
 * - {@link HomebridgeLogClient.history} - a one-shot REST whole-file download parsed into records, optionally trimmed to the most recent N lines.
 * - {@link HomebridgeLogClient.follow} - a live socket tail: the server's ~500-line seed followed by genuinely new lines, streamed indefinitely.
 * - {@link HomebridgeLogClient.tail} - a {@link TailRequest}-driven dispatcher that selects `history`, `follow`, the socket-first `follow-history` join, or the
 *   hedged-seed time-bounded `window` channel.
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
import { DEFAULT_HOST, DEFAULT_PORT, SEED_QUIESCENCE_MS, SEED_SETTLE_MS, SEED_WINDOW_MAX_MS } from "./settings.ts";
import { HbpuAbortError, Watchdog, composeSignals, noOpLog, takeLast } from "../util.ts";
import type { HomebridgePluginLogging, Nullable } from "../util.ts";
import type { LogClientCredentials, LogQuantity, LogRecord, TailRequest } from "./types.ts";
import type { LogSocketFactory, LogSocketLike, TokenProvider } from "./socket.ts";
import { parseLogLine, parseLogTimestamp } from "./parser.ts";
import { acquireToken } from "./auth.ts";
import { downloadLog } from "./rest.ts";
import { logSocketFactory } from "./socket.ts";
import { stitchLive } from "./stitch.ts";
import { timeWindow } from "./time-window.ts";

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

// The tagged, non-rejecting outcome of the windowed channel's speculative download, observed by the gate's race. The download promise's own rejection is neutralized
// separately; this derived tag turns "the download finished" into a value the race can win on without either arm ever rejecting: `done` carries the completed records'
// availability (the gate then uses the download), `failed` latches the error so the gate can drop the settled arm and fall to a seed-only phase.
type WindowDownloadOutcome = { readonly kind: "done" } | { readonly error: unknown; readonly kind: "failed" };

// The shape of the `window` arm of {@link TailRequest}, narrowed once at the `tail()` dispatch and threaded through the windowed channel. `since` is the inclusive lower
// bound (`null` for an unbounded-below `--until`-only window); `until` is the user's explicit upper bound (`null` for a bare `--since`, which the engine fills with the
// snapshot horizon for a one-shot); `follow` selects live continuation versus one-shot termination.
interface WindowRequest {

  readonly follow: boolean;
  readonly since: Nullable<number>;
  readonly until: Nullable<number>;
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
   * - `window` - the hedged-seed time-bounded channel: the socket connects and buffers its seed while a parallel abortable whole-file download runs, a strict-coverage
   *   gate decides whether the seed covers `[since, until]` (serve from the seed and abort the download) or not (fall back to the download, stitched with the seed),
   *   and the merged output is time-window-filtered. A one-shot window terminates when its content has been served; a `follow` window continues live.
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

      case "window": {

        return this.#stream(options.signal, async function *(this: HomebridgeLogClient, callSignal: AbortSignal): AsyncGenerator<LogRecord> {

          yield* this.#window(request, callSignal);
        });
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

        // Buffer the resolved live line (oldest-first) and carry the freshly-issued pull forward. This is the small primitive the windowed gate shares with this loop.
        pendingNext = this.#bufferLine(bufferedLive, result.value, liveIterator);
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

  // Windowed channel implementation - the hedged-seed time-bounded query. Connects the socket, captures the one-shot snapshot horizon, and wraps the merged record stream
  // in the engine-owned `timeWindow` transform so the whole output is filtered to `[since, until]` in one pass (the carry-forward survives the seed -> live and
  // the stitch -> live boundaries). The raw merged stream - the hedge, the strict-coverage gate, the seed-served-vs-download decision, and the wall-clock one-shot
  // termination - is produced by `#windowRecords`; this wrapper owns only the socket lifetime and the time-window upper bound. `effectiveUntil` fills a null `until` with
  // the snapshot horizon for a one-shot (so a bare `--since` is bounded at "now") but leaves an explicit `until` and a `follow` window's `until` untouched, so a future
  // `--until` is never narrowed into emptiness.
  async *#window(request: WindowRequest, callSignal: AbortSignal): AsyncGenerator<LogRecord> {

    const horizonNow = Date.now();
    const effectiveUntil = request.follow ? request.until : (request.until ?? horizonNow);
    const socket = this.#createSocket(callSignal);

    try {

      yield* timeWindow(this.#windowRecords(request, horizonNow, socket, callSignal), { since: request.since, until: effectiveUntil });
    } finally {

      // Dispose the per-call socket on every exit path. `#windowRecords` has already cleared its own wall-clock timers in its own finally by the time this runs, so no
      // `setTimeout` outlives the channel.
      await socket[Symbol.asyncDispose]();
    }
  }

  // The raw (pre-time-window) record stream for the windowed channel: the hedge setup, the bounded two-phase coverage gate, the seed-vs-download branch, and the
  // wall-clock one-shot terminator. Separate from `#window` so the gate's exit semantics - which diverge from `#followHistory` and ARE the channel's essence - read as
  // their own two race loops rather than being forced behind a shared callback; only the small buffer-and-carry primitive (`#bufferLine`), the download collector
  // (`#collectHistory`), and the `Watchdog` are reused. `socket` is owned by `#window`; this method owns the download child controller and the terminator timers.
  async *#windowRecords(request: WindowRequest, horizonNow: number, socket: LogSocketLike, callSignal: AbortSignal): AsyncGenerator<LogRecord> {

    const { follow, since } = request;

    // The single live iterator. The socket is single-consumer, so exactly one iterator is pulled - here through the gate and, on the seed-served path, for the live
    // continuation. One in-flight `next()` is carried across the gate so the pull outstanding when the gate decides is never discarded.
    const liveIterator = socket.stdout()[Symbol.asyncIterator]();

    // A dedicated child controller composed under the call signal, so aborting it cancels ONLY the speculative download (reason `"replaced"`) and never the socket or the
    // call - the socket must survive a seed-covers abort to keep serving the window.
    const downloadController = new AbortController();
    const downloadSignal = composeSignals(callSignal, downloadController.signal);

    // Start the speculative whole-file download in parallel with buffering the seed. It is reused verbatim from the history path (`#collectHistory("all", ...)`), made
    // abortable because `#collectHistory` forwards the download child controller's signal to `downloadLog`. Two observers attach AT CREATION so neither floats on any
    // exit: the base `.catch` absorbs the rejection that arrives on a seed-covers abort or a genuine failure, and the derived `downloadTag` turns completion into a
    // non-rejecting value the gate's race can win on.
    const downloadPromise = this.#collectHistory("all", downloadSignal);

    downloadPromise.catch((): void => { /* Observed via `downloadTag`; on a seed-covers abort the rejection is expected and intentionally discarded. */ });

    const downloadTag: Promise<WindowDownloadOutcome> = downloadPromise.then((): WindowDownloadOutcome => ({ kind: "done" }),
      (error: unknown): WindowDownloadOutcome => ({ error, kind: "failed" }));

    // The seed buffered (oldest-first) while the gate decides. `liveDone` records the socket ending before the gate could leave the buffering loop.
    const bufferedSeed: LogRecord[] = [];
    let pendingNext = liveIterator.next();
    let liveDone = false;

    // The terminator state for a seed-served one-shot (armed only there). Held here so the finally clears both timers on every exit path - no `setTimeout` outlives
    // the channel.
    let watchdog: Watchdog | undefined;
    let capTimer: ReturnType<typeof setTimeout> | undefined;

    try {

      // The gate, fused with the seed-plus-live buffering. A single loop buffers the seed (oldest-first) like `#followHistory`, while watching for the coverage
      // decision: the first parseable-timestamp seed line decides whether the seed strictly covers `[since, until]`. If it covers, short-circuit to the seed branch
      // and abort the download; if it does NOT (a deep window), keep buffering the FULL seed so the no-cover stitch has a real overlap region to align against - a
      // single-line buffer would manufacture a spurious gap marker. The bounded Phase 2 handles a download that FAILS before coverage is decided (the seed may still
      // cover); a failure once a deep / unbounded-below window is established surfaces the actionable error, because then neither source can serve.
      let decision: "no-cover" | "seed-covers" = "no-cover";

      // An unbounded-below window (a bare `--until`) can never be covered by the recent ~500-line seed, so coverage is settled (no-cover) up front and seed timestamps
      // are never inspected; otherwise the first parseable-timestamp seed line decides.
      let coverageDecided = since === null;

      for(;;) {

        // eslint-disable-next-line no-await-in-loop
        const winner = await Promise.race([ pendingNext.then((): "live" => "live"), downloadTag ]);

        if(winner !== "live") {

          if(winner.kind === "done") {

            // The whole-file download completed. It is authoritative and there is no stall left to save, so stop buffering and serve the no-cover fallback - never keep
            // racing the now-settled tag (which would spin).
            break;
          }

          // `kind === "failed"` (a systemd 400, a dead token, the server down). If coverage is not yet decided, the seed might still cover, so hand off to the bounded
          // seed-only Phase 2. If a deep / unbounded-below window is already established, neither source can serve it, so surface the actionable error.
          if(!coverageDecided && (since !== null)) {

            // eslint-disable-next-line no-await-in-loop
            const phase2 = await this.#windowGatePhase2({ bufferedSeed, horizonNow, latchedError: winner.error, liveIterator, pendingNext, since });

            pendingNext = phase2.pendingNext;
            decision = "seed-covers";

            break;
          }

          throw winner.error;
        }

        // eslint-disable-next-line no-await-in-loop
        const result = await pendingNext;

        if(result.done) {

          // The socket ended before the download finished. There is no more live to buffer or continue; fall to the no-cover fallback (which awaits the download).
          liveDone = true;

          break;
        }

        if(!coverageDecided) {

          const record = parseLogLine(result.value);
          const seedOldest = (record.timestamp !== null) ? parseLogTimestamp(record.timestamp) : null;

          // Skip a leading null-epoch orphan (a continuation line, or an unrecognized-locale head); only a parseable timestamp decides coverage.
          if(seedOldest !== null) {

            coverageDecided = true;

            // STRICT `<`: the seed is count-bounded and timestamps are whole-second, so an equal-boundary second could have older same-second lines truncated out of the
            // seed; strict `<` guarantees nothing in-window was truncated, and an exact boundary falls back to the download.
            if((since !== null) && (seedOldest < since)) {

              decision = "seed-covers";

              // The seed covers the window, so the speculative download is wasted: abort ONLY it (the socket survives) with the supersession reason, consume the deciding
              // line, and break to the seed-served branch.
              downloadController.abort(new HbpuAbortError("replaced"));
              pendingNext = this.#bufferLine(bufferedSeed, result.value, liveIterator);

              break;
            }

            // A deep window: the seed does not reach back to `since`, so keep buffering the full seed for a correct stitch, like `#followHistory`. Fall through.
          }
        }

        pendingNext = this.#bufferLine(bufferedSeed, result.value, liveIterator);
      }

      // Serve the decided branch.
      if(decision === "seed-covers") {

        // Seed-covered: serve the window from the socket - the buffered seed, then continue live from the SAME iterator. CONCATENATE; never `stitchLive` (there is a
        // single source with no overlap, so a stitch would manufacture a spurious gap). The download is aborted (seed-covers) or failed (Phase 2) and is not awaited.
        if(!follow) {

          // Arm the wall-clock one-shot terminator: a re-armable quiescence `Watchdog` (held off until the settle floor so a sub-floor stall cannot truncate the
          // seed) plus a hard cap, both ending the channel by aborting the socket so the live pull resolves `done`. Both timers are cleared in the finally.
          const terminate = (): void => {

            if(capTimer !== undefined) {

              clearTimeout(capTimer);
              capTimer = undefined;
            }

            watchdog?.[Symbol.dispose]();
            socket.abort(new HbpuAbortError("timeout"));
          };

          watchdog = new Watchdog({ onFire: (): void => {

            // Hold the terminator off until the settle floor so an intra-burst stall shorter than the floor cannot be mistaken for the end of the seed burst; past
            // the floor, a full quiescence gap with no new source line ends the one-shot.
            if(Date.now() < (horizonNow + SEED_SETTLE_MS)) {

              watchdog?.arm();

              return;
            }

            terminate();
          }, signal: callSignal, timeoutMs: SEED_QUIESCENCE_MS });

          // The hard cap fires SEED_WINDOW_MAX_MS after the horizon regardless of activity, so a perpetually-chatty log (whose post-horizon lines are filtered out
          // of the window but still re-arm quiescence) cannot keep the one-shot open forever.
          capTimer = setTimeout(terminate, Math.max(0, (horizonNow + SEED_WINDOW_MAX_MS) - Date.now()));

          watchdog.arm();
        }

        for(const record of bufferedSeed) {

          // Re-arm the quiescence terminator on every source line (a no-op for a `follow` window, which arms no terminator).
          watchdog?.arm();

          yield record;
        }

        if(!liveDone) {

          // Drain the carried pull first (so the in-flight line is not lost), then continue the live stream. On a one-shot the terminator aborts the socket when the
          // window has gone quiescent or the cap fires, which resolves the outstanding pull `done` and ends the loop; a `follow` window runs until the socket ends or the
          // call is torn down.
          let result = await pendingNext;

          while(!result.done) {

            watchdog?.arm();

            yield parseLogLine(result.value);

            // eslint-disable-next-line no-await-in-loop
            result = await liveIterator.next();
          }
        }
      } else {

        // No-cover fallback: the seed cannot cover the window (or unbounded-below, or the download already completed). Await the download - if it errored, its
        // actionable message surfaces here - then join it with the buffered seed at their overlap and serve. `stitchLive` never drops a distinct live line.
        const history = await downloadPromise;

        for(const record of stitchLive(history, bufferedSeed)) {

          yield record;
        }

        // A `follow` window continues live from the iterator; a one-shot ends here - the finite download already carries `[since, ~now]`, so the generator ends
        // naturally once the stitched records are served, and there is no live tail to wall-clock-bound.
        if(follow && !liveDone) {

          let result = await pendingNext;

          while(!result.done) {

            yield parseLogLine(result.value);

            // eslint-disable-next-line no-await-in-loop
            result = await liveIterator.next();
          }
        }
      }
    } finally {

      // Clear BOTH wall-clock timers on every exit path - normal completion, the terminator firing, an early break, a thrown error, or call teardown - so no `setTimeout`
      // survives to fire onto a torn-down channel. Disposal is idempotent, so a timer the terminator already cleared is harmless to clear again.
      if(capTimer !== undefined) {

        clearTimeout(capTimer);
      }

      watchdog?.[Symbol.dispose]();
    }
  }

  // Phase 2 of the windowed gate, reached ONLY after the speculative download has failed: the seed is now the sole hope, so await the SAME outstanding pull alone (the
  // settled download tag has been dropped from the race - a single-consumer iterator forbids a second concurrent `next()`), bounded by a wall-clock gate deadline set
  // a hard cap (`SEED_WINDOW_MAX_MS`) past the snapshot horizon. A parseable seed line that strictly covers the window serves from the seed (returning the carried pull);
  // a line that cannot cover, the deadline firing, or the socket ending with no parseable line all THROW the latched error (so an all-null / non-en-US seed against a
  // dead download cannot hang). The deciding line is consumed into `bufferedSeed`.
  async #windowGatePhase2(state: { bufferedSeed: LogRecord[]; horizonNow: number; latchedError: unknown; liveIterator: AsyncIterator<string>;
    pendingNext: Promise<IteratorResult<string>>; since: number; }): Promise<{ pendingNext: Promise<IteratorResult<string>> }> {

    const { bufferedSeed, horizonNow, latchedError, liveIterator, since } = state;

    // Continue with the outstanding pull Phase 1 left in flight; re-issue locally as the scan advances.
    let pendingNext = state.pendingNext;

    // The wall-clock gate deadline: bound the seed-only wait to the same hard cap, measured from the snapshot horizon, so a never-arriving parseable line cannot hang.
    const deadline: PromiseWithResolvers<"deadline"> = Promise.withResolvers();
    const deadlineTimer = setTimeout((): void => deadline.resolve("deadline"), Math.max(0, (horizonNow + SEED_WINDOW_MAX_MS) - Date.now()));

    try {

      for(;;) {

        // eslint-disable-next-line no-await-in-loop
        const winner = await Promise.race([ pendingNext.then((): "live" => "live"), deadline.promise ]);

        if(winner === "deadline") {

          // The seed never produced a parseable line within the cap. With the download already failed, there is nothing left to serve.
          throw latchedError;
        }

        // eslint-disable-next-line no-await-in-loop
        const result = await pendingNext;

        if(result.done) {

          // The socket ended with no parseable seed line and the download failed - surface the actionable error rather than hang.
          throw latchedError;
        }

        const record = parseLogLine(result.value);
        const seedOldest = (record.timestamp !== null) ? parseLogTimestamp(record.timestamp) : null;

        if(seedOldest === null) {

          // Skip a leading null-epoch orphan and keep scanning for the first parseable-timestamp line.
          pendingNext = this.#bufferLine(bufferedSeed, result.value, liveIterator);

          continue;
        }

        if(seedOldest < since) {

          // The seed strictly covers the window: serve from the seed. Consume the deciding line, then return the fresh carried pull - exactly as Phase 1
          // does before its own break. The pull is wrapped so the async return does NOT await it (the carry must stay in flight).
          return { pendingNext: this.#bufferLine(bufferedSeed, result.value, liveIterator) };
        }

        // The seed cannot cover the window and the download failed - surface the actionable error.
        throw latchedError;
      }
    } finally {

      clearTimeout(deadlineTimer);
    }
  }

  // Buffer a resolved live line into `buffer` (oldest-first) and issue the next pull, returning the in-flight `next()`. The single primitive shared between
  // the windowed gate and `#followHistory`: each carries exactly one outstanding pull across its buffering loop, so the parse-and-advance step lives in one place.
  #bufferLine(buffer: LogRecord[], value: string, liveIterator: AsyncIterator<string>): Promise<IteratorResult<string>> {

    buffer.push(parseLogLine(value));

    return liveIterator.next();
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
  // The call signal is forwarded to `downloadLog` so an aborted call (the windowed hedge superseding the speculative download, or a per-call teardown) cancels the
  // in-flight request and releases the connection rather than letting it drain in the background.
  async *#downloadRecords(callSignal: AbortSignal): AsyncGenerator<LogRecord> {

    const token = await this.#tokenProvider(callSignal);

    for await (const line of downloadLog({ fetch: this.#fetch, host: this.#host, port: this.#port, signal: callSignal, tls: this.#tls, token })) {

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
