/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * logclient/client.ts: AsyncDisposable Homebridge UI log client composing the auth, REST, socket, parser, and stitch transports into history/follow/tail streams.
 */

/**
 * AsyncDisposable client for the Homebridge UI log stream.
 *
 * {@link HomebridgeLogClient} is the subsystem-local composition root: it holds the connection configuration and the credentials, and it composes the pure leaf modules
 * (`parser.ts`, `stitch.ts`, `time-window.ts`) with the transports (`auth.ts`, `rest.ts`, `socket.ts`) into the consumer-facing channels below, each returning a
 * {@link LogStream}:
 *
 * - {@link HomebridgeLogClient.history} - a one-shot REST whole-file download parsed into records, optionally trimmed to the most recent N lines.
 * - {@link HomebridgeLogClient.follow} - a live socket tail: the server's ~500-line seed followed by genuinely new lines, streamed indefinitely.
 * - {@link HomebridgeLogClient.tail} - a {@link TailRequest}-driven dispatcher over the channels above and the hedged-seed ones: the most recent lines (`history` and
 *   `follow-history`, served from the socket's seed whenever it holds them) and the time-bounded `window`.
 *
 * The following design points matter:
 *
 * - **Token lifecycle via a closure.** The client builds one {@link TokenProvider} closure over {@link acquireToken} and the stored credentials. The socket invokes it on
 *   every connect attempt, so a `password`/`noauth` credential re-authenticates from the stored credentials on each reconnect (surviving token expiry across a drop). A
 *   static `token` credential is returned verbatim with no network call, so it is never "refreshed"; an expired static token instead surfaces later when the socket
 *   handshake is rejected.
 * - **Leak-free per-call teardown.** Each channel is an async generator wrapper, mirroring `mp4-assembler.ts`. It builds a per-call {@link LogSocketLike} through the
 *   injected {@link LogSocketFactory} under a per-call abort controller composed with the client's lifetime, and its `finally` disposes that socket and aborts the
 *   per-call controller. Both `await using stream = client.follow()` and an early `break` out of the iteration therefore tear the per-call socket down with no leak.
 *
 * Lifetime is a composed {@link AbortSignal}: the optional caller `signal` composed with the client's own controller. Disposing the client (or aborting the caller
 * signal) aborts every in-flight channel, because each channel composes its per-call signal under the client's lifetime signal.
 *
 * @module
 */
import { DEFAULT_HOST, DEFAULT_PORT, SEED_GATE_MAX_SKIP, SEED_QUIESCENCE_MS, SEED_SETTLE_MS, SEED_WINDOW_MAX_MS } from "./settings.ts";
import { HbpuAbortError, Watchdog, composeSignals, noOpLog, takeLast } from "../util.ts";
import type { HomebridgePluginLogging, Nullable } from "../util.ts";
import type { LogClientCredentials, LogQuantity, LogRecord, TailRequest } from "./types.ts";
import type { LogSocketFactory, LogSocketLike, TokenProvider } from "./socket.ts";
import { SeedGate, parseLogLine, parseLogTimestamp } from "./parser.ts";
import type { Clock } from "../clock.ts";
import { acquireToken } from "./auth.ts";
import { downloadLog } from "./rest.ts";
import { logSocketFactory } from "./socket.ts";
import { stitchLive } from "./stitch.ts";
import { systemClock } from "../clock.ts";
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
 * @property clock         - Optional time source for the seed-served channels' deadlines, the download's stall bound, and every socket this client creates. Defaults to
 *                           {@link systemClock}, whose members ARE the platform primitives, so the default path is behavior-neutral. A test injects a `TestClock` seeded
 *                           at the horizon it wants and drives the whole channel - the settle floor, the quiescence terminator, the hard cap, and the gate deadline -
 *                           by advancing it.
 * @property credentials   - The credentials used to authenticate. See {@link LogClientCredentials}.
 * @property fetch         - Optional `fetch` implementation for the auth and REST transports. Defaults to the global `fetch`. Injected so the client is testable without
 *                           a live server.
 * @property host          - The hostname or IP of the homebridge-config-ui-x server. Defaults to `localhost`.
 * @property log           - Optional logger for connection lifecycle and diagnostics. Defaults to a silent no-op sink when omitted.
 * @property port          - The TCP port the server listens on. Defaults to `8581`.
 * @property signal        - Optional parent {@link AbortSignal} composed with the client's internal controller. When it aborts, every in-flight channel tears down.
 * @property socketFactory - Optional factory for constructing the live-log socket. Defaults to {@link logSocketFactory}. Injected so the client is testable without
 *                           a WebSocket.
 * @property tls           - When `true`, use the secure (`https`/`wss`) schemes; when `false` or omitted, plaintext (`http`/`ws`).
 *
 * @category Log Client
 */
export interface HomebridgeLogClientOptions {

  readonly clock?: Clock;
  readonly credentials: LogClientCredentials;
  readonly fetch?: typeof fetch;
  readonly host?: string;
  readonly log?: HomebridgePluginLogging;
  readonly port?: number;
  readonly signal?: AbortSignal;
  readonly socketFactory?: LogSocketFactory;
  readonly tls?: boolean;
}

// The tagged, non-rejecting outcome of a seed-served channel's speculative download, observed by the gate's race. The download promise's own rejection is neutralized
// separately; this derived tag turns "the download finished" into a value the race can win on without either arm ever rejecting: `done` carries the completed records'
// availability (the gate then uses the download), `failed` latches the error so the gate can drop the settled arm and fall to a seed-only phase.
type HedgeOutcome = { readonly kind: "done" } | { readonly error: unknown; readonly kind: "failed" };

// A seed-served channel's verdict on one line of the socket's stream: the stream `covers` the request, `cannot` cover it, or stays `undecided` until a later line.
type SeedVerdict = "cannot" | "covers" | "undecided";

// The speculative whole-file download a seed-served channel runs beside its socket: the controller that cancels only the download, the collected records, and the
// outcome tag a gate races on.
interface Hedge {

  readonly controller: AbortController;
  readonly download: Promise<LogRecord[]>;
  readonly outcome: Promise<HedgeOutcome>;
}

// What the hedged seed gate works over: the buffer it fills oldest-first, the verdict it asks of each line (`null` when coverage is ruled out from the start), the
// channel's hedge, the snapshot horizon its seed-only phase is bounded from, and the channel's single live iterator.
interface HedgedSeedGate {

  readonly buffered: LogRecord[];
  readonly decide: Nullable<(record: LogRecord) => SeedVerdict>;
  readonly hedge: Hedge;
  readonly horizonNow: number;
  readonly liveIterator: AsyncIterator<string>;
}

// Where the hedged seed gate leaves its channel: the source that serves, whether the socket ended during the gate, and the pull outstanding when the gate decided.
interface HedgedSeedGateResult {

  readonly liveDone: boolean;
  readonly pendingNext: Promise<IteratorResult<string>>;
  readonly served: "download" | "seed";
}

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

  // The client's time source, RESOLVED here rather than passed on unresolved as a pure composer would. This class is not a pure composer: it reads `now()` and arms
  // the seed-served channels' own timers itself, so it needs a definite clock, and the sockets and downloads it starts inherit that same one.
  readonly #clock: Clock;

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

    this.#clock = options.clock ?? systemClock;
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

    // Build the token provider once. Each caller hands it the signal of the work it serves - the socket a connect attempt's, a history download its call's - and every
    // one of those is composed under this client's own signal, so forwarding it to `acquireToken` is what lets the client's teardown cancel a login in flight rather
    // than wait for the server to answer it. Each invocation re-derives the token from the stored credentials, which is exactly the "re-auth on reconnect for
    // password/noauth, return-verbatim for token" behavior the token lifecycle requires.
    this.#tokenProvider = (signal: AbortSignal): Promise<string> => acquireToken(this.#credentials, { fetch: this.#fetch, host: this.#host, port: this.#port, signal,
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
   * deep-history channel paid only when the caller explicitly wants history beyond the socket's ~500-line seed. A caller after the most recent lines asks
   * {@link HomebridgeLogClient.tail} for a `history` count instead, which serves them from the socket's seed whenever the seed holds them.
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
   * Builds a {@link LogSocketLike} through the injected {@link LogSocketFactory} and yields each parsed {@link LogRecord} the server streams - the ~500-line seed
   * first, then genuinely new lines indefinitely. The stream terminates only when the caller stops iterating (an early `break`, which disposes the socket), the
   * per-call signal aborts, or the client is disposed.
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
   * - `history` - the most recent `quantity` lines, one-shot. A count is served by the hedged seed: the socket connects and buffers its stream while a parallel
   *   abortable whole-file download runs, and once the stream holds the count the download is aborted and the last `quantity` lines of the opening burst are served;
   *   a count the stream falls short of is served by the download, trimmed to the quantity. `"all"` delegates to {@link HomebridgeLogClient.history}.
   * - `follow` - delegates to {@link HomebridgeLogClient.follow}.
   * - `follow-history` - the most recent `quantity` lines, then the live stream. A count the socket's stream holds is served from it exactly as for `history`, and
   *   the live stream continues from the same iterator. Otherwise it is the socket-first join: the socket buffers its seed plus any live lines that arrive during the
   *   REST download into an ordered list, the download is trimmed to the request's quantity, the two are joined by {@link stitchLive} so the boundary overlap is
   *   removed without dropping a distinct live line, and the live stream continues. Connecting the socket first is what guarantees no live line produced during the
   *   download is lost.
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

          yield* this.#recent(request.quantity, true, callSignal);
        });
      }

      case "history": {

        // All of history is the download alone, so it opens no socket; a count goes through the hedged seed.
        if(request.quantity === "all") {

          return this.history({ quantity: "all", signal: options.signal });
        }

        const quantity = request.quantity;

        return this.#stream(options.signal, async function *(this: HomebridgeLogClient, callSignal: AbortSignal): AsyncGenerator<LogRecord> {

          yield* this.#recent(quantity, false, callSignal);
        });
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

  // Wrap a socket's raw `stdout()` in a per-stream seed gate, dropping the leading lines the server's byte-offset seed makes unusable - the truncated first fragment and
  // the `Loading logs...` / `File: ...` preamble - up to the first genuine log entry, then yielding every line thereafter. Every socket-sourced channel (follow,
  // follow-history, window) funnels its live lines through here, so the seed hygiene is defined ONCE; the REST download path is clean from byte 0 and is deliberately not
  // gated. The gate is a single per-call object, so it latches open once at the start of the stream and is a boolean short-circuit for the rest of the stream's life. It
  // wraps a single `stdout()` iterator, preserving the socket's single-consumer contract, and forwards cleanup: an early `return` on this generator propagates to the
  // underlying `stdout()` iteration, and disposing the socket ends `stdout()` and so ends this wrapper.
  async *#gatedStdout(socket: LogSocketLike): AsyncGenerator<string> {

    const gate = new SeedGate(SEED_GATE_MAX_SKIP);

    for await (const line of socket.stdout()) {

      if(gate.admit(line)) {

        yield line;
      }
    }
  }

  // Follow channel implementation. Builds a per-call socket through the injected factory and yields each parsed line. The socket is disposed in the `finally` so an early
  // `break` or client disposal tears it down leak-free, mirroring the `await using` discipline `mp4-assembler.ts` relies on for its source.
  async *#follow(callSignal: AbortSignal): AsyncGenerator<LogRecord> {

    const socket = this.#createSocket(callSignal);

    try {

      for await (const line of this.#gatedStdout(socket)) {

        yield parseLogLine(line);
      }
    } finally {

      // Dispose the per-call socket on every exit path. Disposal aborts the socket and awaits its reconnect loop, so the WebSocket is closed by the time this returns.
      await socket[Symbol.asyncDispose]();
    }
  }

  // Most-recent-lines channel implementation, one-shot or followed: every `history` count and every `follow-history` request. The socket connects first, so no live
  // line produced during a download is lost, and its stream - the seed, then live lines - is buffered through the hedged seed gate while a speculative download runs.
  // The stream is a contiguous tail of the log that only grows, so a count is covered the moment the stream holds that many lines: the download is aborted, the
  // channel waits for the opening burst to end so the lines it keeps are the most recent, and it serves the last `quantity` of them. A count the stream falls short
  // of, and every request for all of history, is served by the download instead - alone for a one-shot, exactly as the REST channel serves it, or joined to the
  // buffered stream by `stitchLive` for a follow. A followed request then continues live from the same iterator, the pull outstanding at the switch carried across it
  // so no line is lost or double-counted.
  async *#recent(quantity: LogQuantity, follow: boolean, callSignal: AbortSignal): AsyncGenerator<LogRecord> {

    const horizonNow = this.#clock.now();
    const socket = this.#createSocket(callSignal);

    try {

      // The single live iterator: the socket is single-consumer, so exactly one iterator is pulled - through the gate and, on a follow, for the live continuation.
      const liveIterator = this.#gatedStdout(socket)[Symbol.asyncIterator]();
      const buffered: LogRecord[] = [];

      // A count is covered once this line brings the stream to `quantity`. The recent seed can never cover all of history, so that request has coverage ruled out.
      const decide = (quantity === "all") ? null : (): SeedVerdict => (((buffered.length + 1) >= quantity) ? "covers" : "undecided");

      // A count the stream fell short of rests on the download alone, so a failed download is reported with how many of the most recent lines the stream did hold -
      // the count a caller can still ask for without the download. An abort is the caller's own ending, a request for everything has no smaller count to offer, and a
      // stream that held nothing offers no count at all, so each of those surfaces the download's error untouched.
      const shortfall = (error: unknown): unknown => {

        if(callSignal.aborted || (quantity === "all") || (buffered.length === 0)) {

          return error;
        }

        return new Error("Only the most recent " + buffered.length.toString() + ((buffered.length === 1) ? " line is" : " lines are") +
          " available from the live stream, and the whole-file download that would serve more failed", { cause: error });
      };

      const hedge = this.#startHedge(quantity, callSignal);
      let gate: HedgedSeedGateResult;

      try {

        gate = await this.#hedgedSeedGate({ buffered, decide, hedge, horizonNow, liveIterator });
      } catch(error: unknown) {

        throw shortfall(error);
      }

      let { liveDone, pendingNext } = gate;

      if(gate.served === "seed") {

        // The seed covers the count, but the lines to keep are the most recent once the opening burst has ended, so keep buffering - every line re-arms the burst
        // watch - until it says the burst is over.
        const burstEnded: PromiseWithResolvers<"ended"> = Promise.withResolvers();

        {

          using burst = this.#watchSeedBurst(horizonNow, callSignal, (): void => burstEnded.resolve("ended"));

          for(;;) {

            // eslint-disable-next-line no-await-in-loop
            const winner = await Promise.race([ pendingNext.then((): "live" => "live"), burstEnded.promise ]);

            if(winner === "ended") {

              break;
            }

            // eslint-disable-next-line no-await-in-loop
            const result = await pendingNext;

            if(result.done) {

              liveDone = true;

              break;
            }

            burst.arm();
            pendingNext = this.#bufferLine(buffered, parseLogLine(result.value), liveIterator);
          }
        }

        // Serve the most recent `quantity` lines of the buffer. Only a count reaches this branch, since nothing covers a request for all of history.
        yield* (quantity === "all") ? buffered : buffered.slice(Math.max(0, buffered.length - quantity));
      } else {

        let history: LogRecord[];

        try {

          history = await hedge.download;
        } catch(error: unknown) {

          throw shortfall(error);
        }

        // A one-shot is the download's most recent lines alone, exactly as the REST channel serves them; a follow joins them to the buffered stream at their overlap,
        // which never drops a distinct live line and may emit a bounded run of duplicates or a visible gap marker when no overlap is found.
        if(!follow) {

          yield* history;

          return;
        }

        yield* stitchLive(history, buffered);
      }

      // The live continuation of a followed request: drain the pull outstanding at the switch first, so the in-flight line is not lost, then continue until the socket
      // ends or the call is torn down.
      if(follow && !liveDone) {

        let result = await pendingNext;

        while(!result.done) {

          yield parseLogLine(result.value);

          // eslint-disable-next-line no-await-in-loop
          result = await liveIterator.next();
        }
      }
    } finally {

      // Dispose the per-call socket on every exit path, as every socket-sourced channel does.
      await socket[Symbol.asyncDispose]();
    }
  }

  // Windowed channel implementation - the hedged-seed time-bounded query. Connects the socket, captures the one-shot snapshot horizon, and wraps the merged record stream
  // in the engine-owned `timeWindow` transform so the whole output is filtered to `[since, until]` in one pass (the carry-forward survives the seed -> live and
  // the stitch -> live boundaries). The raw merged stream - the hedge, the strict-coverage gate, the seed-served-vs-download decision, and the clock-driven one-shot
  // termination - is produced by `#windowRecords`; this wrapper owns only the socket lifetime and the time-window upper bound. `effectiveUntil` fills a null `until` with
  // the snapshot horizon for a one-shot (so a bare `--since` is bounded at "now") but leaves an explicit `until` and a `follow` window's `until` untouched, so a future
  // `--until` is never narrowed into emptiness.
  async *#window(request: WindowRequest, callSignal: AbortSignal): AsyncGenerator<LogRecord> {

    const horizonNow = this.#clock.now();
    const effectiveUntil = request.follow ? request.until : (request.until ?? horizonNow);
    const socket = this.#createSocket(callSignal);

    try {

      yield* timeWindow(this.#windowRecords(request, horizonNow, socket, callSignal), { since: request.since, until: effectiveUntil });
    } finally {

      // Dispose the per-call socket on every exit path. `#windowRecords` has already disposed its own timers in its own finally by the time this runs, so no timer
      // outlives the channel.
      await socket[Symbol.asyncDispose]();
    }
  }

  // The raw (pre-time-window) record stream for the windowed channel: the window's coverage verdict handed to the hedged seed gate, then the seed-served or
  // download-served branch, with the burst watch as a one-shot's terminator. `socket` is owned by `#window`.
  async *#windowRecords(request: WindowRequest, horizonNow: number, socket: LogSocketLike, callSignal: AbortSignal): AsyncGenerator<LogRecord> {

    const { follow, since } = request;

    // The single live iterator. The socket is single-consumer, so exactly one iterator is pulled - here through the coverage gate and, on the seed-served path, for the
    // live continuation. The seed gate wrapper drops the seed's leading fragment/preamble upstream, so the first line this channel sees is a genuine entry and the
    // coverage verdict reads a real timestamp; the verdict's own leading-orphan handling remains as defense in depth and never assumes the gate ran.
    const liveIterator = this.#gatedStdout(socket)[Symbol.asyncIterator]();
    const bufferedSeed: LogRecord[] = [];

    // The first parseable-timestamp seed line decides whether the seed strictly covers `[since, until]`. An unbounded-below window (a bare `--until`) can never be
    // covered by the recent ~500-line seed, so its coverage is ruled out up front and seed timestamps are never inspected.
    const decide = (since === null) ? null : (record: LogRecord): SeedVerdict => {

      const seedOldest = (record.timestamp !== null) ? parseLogTimestamp(record.timestamp) : null;

      // Skip a leading null-epoch orphan (a continuation line, or an unrecognized-locale head); only a parseable timestamp decides coverage.
      if(seedOldest === null) {

        return "undecided";
      }

      // STRICT `<`: the seed is count-bounded and timestamps are whole-second, so an equal-boundary second could have older same-second lines truncated out of the
      // seed; strict `<` guarantees nothing in-window was truncated, and an exact boundary falls back to the download.
      return (seedOldest < since) ? "covers" : "cannot";
    };

    const hedge = this.#startHedge("all", callSignal);
    const gate = await this.#hedgedSeedGate({ buffered: bufferedSeed, decide, hedge, horizonNow, liveIterator });

    if(gate.served === "seed") {

      // Seed-covered: serve the window from the socket - the buffered seed, then continue live from the SAME iterator. CONCATENATE; never `stitchLive` (there is a
      // single source with no overlap, so a stitch would manufacture a spurious gap). A one-shot arms the burst watch as its terminator, ending the channel by
      // aborting the socket so the live pull resolves `done`; a `follow` window arms none and runs until the socket ends or the call is torn down.
      using terminator = follow ? undefined : this.#watchSeedBurst(horizonNow, callSignal, (): void => socket.abort(new HbpuAbortError("timeout")));

      for(const record of bufferedSeed) {

        // Re-arm the terminator on every source line.
        terminator?.arm();

        yield record;
      }

      if(!gate.liveDone) {

        // Drain the carried pull first, so the in-flight line is not lost, then continue the live stream.
        let result = await gate.pendingNext;

        while(!result.done) {

          terminator?.arm();

          yield parseLogLine(result.value);

          // eslint-disable-next-line no-await-in-loop
          result = await liveIterator.next();
        }
      }

      return;
    }

    // No-cover fallback: the seed cannot cover the window (or unbounded-below, or the download already completed). Await the download - if it errored, its actionable
    // message surfaces here - then join it with the buffered seed at their overlap and serve. `stitchLive` never drops a distinct live line.
    const history = await hedge.download;

    for(const record of stitchLive(history, bufferedSeed)) {

      yield record;
    }

    // A `follow` window continues live from the iterator; a one-shot ends here - the finite download already carries `[since, ~now]`, so the generator ends naturally
    // once the stitched records are served, and there is no live tail for a clock-driven terminator to bound.
    if(follow && !gate.liveDone) {

      let result = await gate.pendingNext;

      while(!result.done) {

        yield parseLogLine(result.value);

        // eslint-disable-next-line no-await-in-loop
        result = await liveIterator.next();
      }
    }
  }

  // Start a seed-served channel's speculative download: the REST history collected under a child controller composed with the call signal, so aborting the controller
  // cancels ONLY the download (reason `"replaced"`) and never the socket or the call - the socket must survive a seed-covers abort to keep serving. Every observer
  // attaches AT CREATION so none floats on any exit: the base `.catch` absorbs the rejection a seed-covers abort or a genuine failure delivers, and the derived outcome
  // turns settlement into a non-rejecting value the gate's race can win on.
  #startHedge(quantity: LogQuantity, callSignal: AbortSignal): Hedge {

    const controller = new AbortController();
    const download = this.#collectHistory(quantity, composeSignals(callSignal, controller.signal));

    download.catch((): void => {

      // Observed through `outcome`; on a seed-covers abort the rejection is expected and intentionally discarded.
    });

    const outcome = download.then((): HedgeOutcome => ({ kind: "done" }), (error: unknown): HedgeOutcome => ({ error, kind: "failed" }));

    return { controller, download, outcome };
  }

  // The hedged seed gate every seed-served channel passes through. It buffers the socket's stream oldest-first while the hedge's download runs, and asks `decide` about
  // each line until coverage is settled. A line that covers the request aborts only the download and leaves the seed serving; a line that rules coverage out keeps
  // the gate buffering the FULL stream, so a later stitch has a real overlap region to align against - a single-line buffer would manufacture a spurious gap marker. A
  // download that completes first is authoritative, so the download serves. One that fails while coverage is still open hands off to the bounded seed-only phase,
  // since the seed may yet cover; one that fails once coverage is ruled out surfaces its error, because then neither source can serve. The socket ending first leaves
  // the download to serve. One in-flight `next()` is carried across the gate, so the pull outstanding when it decides is never discarded.
  async #hedgedSeedGate({ buffered, decide, hedge, horizonNow, liveIterator }: HedgedSeedGate): Promise<HedgedSeedGateResult> {

    // The verdict still to be reached: it drops to `null` once a line rules coverage out, and starts there for a request the seed can never cover.
    let verdictFor = decide;
    let pendingNext = liveIterator.next();

    for(;;) {

      // eslint-disable-next-line no-await-in-loop
      const winner = await Promise.race([ pendingNext.then((): "live" => "live"), hedge.outcome ]);

      if(winner !== "live") {

        // The download completed first. It is authoritative, so stop buffering - never keep racing the now-settled outcome, which would spin.
        if(winner.kind === "done") {

          return { liveDone: false, pendingNext, served: "download" };
        }

        // The download failed (a systemd 400, a dead token, the server down) with coverage ruled out, so neither source can serve.
        if(verdictFor === null) {

          throw winner.error;
        }

        // eslint-disable-next-line no-await-in-loop
        const phase = await this.#seedOnlyPhase({ buffered, decide: verdictFor, horizonNow, latchedError: winner.error, liveIterator, pendingNext });

        return { liveDone: false, pendingNext: phase.pendingNext, served: "seed" };
      }

      // eslint-disable-next-line no-await-in-loop
      const result = await pendingNext;

      // The socket ended before the download finished, so there is no more stream to buffer or continue and the download serves.
      if(result.done) {

        return { liveDone: true, pendingNext, served: "download" };
      }

      const record = parseLogLine(result.value);

      switch(verdictFor?.(record)) {

        case "covers": {

          // The seed covers the request, so the speculative download is wasted: abort ONLY it, with the supersession reason, and consume the deciding line.
          hedge.controller.abort(new HbpuAbortError("replaced"));

          return { liveDone: false, pendingNext: this.#bufferLine(buffered, record, liveIterator), served: "seed" };
        }

        case "cannot": {

          verdictFor = null;

          break;
        }

        default: {

          break;
        }
      }

      pendingNext = this.#bufferLine(buffered, record, liveIterator);
    }
  }

  // The seed-only phase of the hedged gate, reached ONLY after the download has failed while coverage was still open: the socket's stream is now the sole hope, so
  // await the SAME outstanding pull alone (the settled outcome leaves the race, since a single-consumer iterator forbids a second concurrent `next()`), bounded by a
  // deadline at the hard cap past the snapshot horizon. A line `decide` finds covering serves from the seed, returning the carried pull; a line it rules out, the
  // deadline firing, or the socket ending all THROW the latched error, so a seed that never covers cannot hang against a dead download. Every line short of a ruling-out
  // verdict is buffered, the covering one among them.
  async #seedOnlyPhase(state: { buffered: LogRecord[]; decide: (record: LogRecord) => SeedVerdict; horizonNow: number; latchedError: unknown;
    liveIterator: AsyncIterator<string>; pendingNext: Promise<IteratorResult<string>>; }): Promise<{ pendingNext: Promise<IteratorResult<string>> }> {

    const { buffered, decide, horizonNow, latchedError, liveIterator } = state;

    // Continue with the outstanding pull the gate left in flight; re-issue locally as the scan advances.
    let pendingNext = state.pendingNext;

    // The deadline: bound the seed-only wait to the hard cap, measured from the snapshot horizon, so a never-arriving covering line cannot hang.
    const deadline: PromiseWithResolvers<"deadline"> = Promise.withResolvers();
    const deadlineTimer = this.#scheduleAtHardCap(horizonNow, (): void => deadline.resolve("deadline"));

    try {

      for(;;) {

        // eslint-disable-next-line no-await-in-loop
        const winner = await Promise.race([ pendingNext.then((): "live" => "live"), deadline.promise ]);

        // The seed produced no covering line within the cap. With the download already failed, there is nothing left to serve.
        if(winner === "deadline") {

          throw latchedError;
        }

        // eslint-disable-next-line no-await-in-loop
        const result = await pendingNext;

        // The socket ended short of a covering line and the download failed - surface the actionable error rather than hang.
        if(result.done) {

          throw latchedError;
        }

        const record = parseLogLine(result.value);
        const verdict = decide(record);

        // The seed cannot cover the request and the download failed - surface the actionable error.
        if(verdict === "cannot") {

          throw latchedError;
        }

        pendingNext = this.#bufferLine(buffered, record, liveIterator);

        // The seed covers the request: serve from it. The pull is returned wrapped so the async return does NOT await it - the carry must stay in flight.
        if(verdict === "covers") {

          return { pendingNext };
        }
      }
    } finally {

      deadlineTimer[Symbol.dispose]();
    }
  }

  // Watch for the end of the socket's opening burst - its seed, and any live lines arriving with it - on the client's clock: a full quiescence gap with no new line
  // once the settle floor has passed, or the hard cap, whichever comes first. The floor keeps an intra-burst stall shorter than it from being mistaken for the end of
  // the burst, and the cap keeps a perpetually-chatty log from holding the watch open forever. `onEnd` runs once, when the burst ends. The returned watch is re-armed
  // on every source line and disposed with its channel, so no timer outlives the channel.
  #watchSeedBurst(horizonNow: number, signal: AbortSignal, onEnd: () => void): { readonly arm: () => void } & Disposable {

    // Whichever ending comes first - the quiet gap past the floor, or the cap - releases the watch's timers before running `onEnd`, so the burst ends exactly once.
    const end = (): void => {

      watch[Symbol.dispose]();
      onEnd();
    };

    const watchdog: Watchdog = new Watchdog({ clock: this.#clock, onFire: (): void => {

      // Short of the settle floor, a quiet gap is not yet the end of the burst, so keep watching.
      if(this.#clock.now() < (horizonNow + SEED_SETTLE_MS)) {

        watchdog.arm();

        return;
      }

      end();
    }, signal, timeoutMs: SEED_QUIESCENCE_MS });

    const capTimer = this.#scheduleAtHardCap(horizonNow, end);

    const watch = {

      arm: (): void => watchdog.arm(),
      [Symbol.dispose]: (): void => {

        capTimer[Symbol.dispose]();
        watchdog[Symbol.dispose]();
      }
    };

    watchdog.arm();

    return watch;
  }

  // Arm `callback` at the hard cap: SEED_WINDOW_MAX_MS past the snapshot horizon, clamped at zero so a horizon already that old fires immediately rather than
  // reaching backward. Every caller that needs this deadline - the seed-served one-shot's cap and the Phase 2 gate among them - goes through here, so the arithmetic
  // and the clock it reads have one home and no caller's deadline can drift from another's.
  #scheduleAtHardCap(horizonNow: number, callback: () => void): Disposable {

    return this.#clock.schedule(callback, Math.max(0, (horizonNow + SEED_WINDOW_MAX_MS) - this.#clock.now()));
  }

  // Buffer a resolved line's record into `buffer` (oldest-first) and issue the next pull, returning the in-flight `next()`. The single primitive every buffering loop
  // shares - the hedged gate, its seed-only phase and the count's burst wait: each carries exactly one outstanding pull, so the push-and-advance step lives in one place.
  #bufferLine(buffer: LogRecord[], record: LogRecord, liveIterator: AsyncIterator<string>): Promise<IteratorResult<string>> {

    buffer.push(record);

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

    for await (const line of downloadLog({ clock: this.#clock, fetch: this.#fetch, host: this.#host, port: this.#port, signal: callSignal, tls: this.#tls, token })) {

      yield parseLogLine(line);
    }
  }

  // Construct a per-call live-log socket through the injected factory, wired with the client's connection target, the shared token provider, and the per-call signal
  // so the socket's lifetime is bounded by the call's. Routing construction through the factory (rather than `new LogSocket(...)`) is what lets a test substitute a fake
  // socket and exercise the client without a WebSocket. `refreshable` is derived from the credential DU once at construction (a `password`/`noauth` credential re-
  // authenticates on each connect, so a handshake rejection is transient; a static `token` cannot be refreshed, so a handshake rejection is permanent and the socket
  // fails fast instead of retrying the same doomed token forever).
  #createSocket(callSignal: AbortSignal): LogSocketLike {

    return this.#socketFactory.create({ clock: this.#clock, host: this.#host, log: this.#log, port: this.#port, refreshable: this.#refreshable, signal: callSignal,
      tls: this.#tls, tokenProvider: this.#tokenProvider });
  }
}
