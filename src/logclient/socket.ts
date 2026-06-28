/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * logclient/socket.ts: AsyncDisposable Socket.IO log-stream client with reconnect, ping-liveness, and a bounded push-to-pull line stream.
 */

/**
 * AsyncDisposable live-log socket for the Homebridge UI log stream.
 *
 * {@link LogSocket} owns a single WebSocket connection to the homebridge-config-ui-x Socket.IO log namespace and surfaces the raw `stdout` text the server streams as a
 * bounded push-to-pull `AsyncIterable<string>`. It composes the library's own primitives rather than reinventing them: {@link composeSignals} / {@link onAbort} for
 * lifetime, {@link Watchdog} for ping liveness, {@link retry} (driving the connect phase with the log client's own dev-tuned backoff curve), and {@link HbpuAbortError}
 * for the abort taxonomy. The wire framing is delegated entirely to the pure {@link decodeFrame} / {@link encodeFrame} codec.
 *
 * Lifecycle, in one pass:
 *
 * - A background reconnect loop runs for the socket's lifetime: `while(!signal.aborted)`, each iteration `retry()`s the CONNECT PHASE ONLY (re-acquire the token, open
 *   the WebSocket, await the Engine.IO open handshake, join the `/log` namespace, emit `tail-log`). Wrapping only the connect phase in `retry` means the exponential
 *   backoff curve RESETS after every healthy session - a socket that stays connected for hours and then drops reconnects briskly rather than at the climbed-up delay a
 *   single long-lived `retry` would have reached.
 * - The connect-phase backoff is the log client's own jittered exponential curve: a 500 ms base (`RECONNECT_BASE_MS`) doubling each attempt and plateauing at a 5-second
 *   ceiling (`RECONNECT_CAP_MS`), deliberately snappier than `defaultRetryBackoff`'s 30-second ceiling so the tail resumes promptly after a Homebridge restart. `random`
 *   is injectable (default `Math.random`) so the jitter is deterministic in tests.
 * - `shouldRetry` vetoes a retry the instant a permanent authentication failure surfaces (wrong password, missing OTP, noauth disabled), so a credential problem fails
 *   the socket fast with an actionable error rather than looping forever.
 * - Once connected, each server ping (`"2"`) is answered with a pong (`"3"`) and re-arms the liveness {@link Watchdog}; if no ping arrives within
 *   `pingInterval + pingTimeout + MARGIN_MS`, the watchdog aborts the session and the loop reconnects.
 * - A Socket.IO CONNECT_ERROR (`44/log,`) on the namespace is surfaced as a connect-phase failure - transient and retried for a refreshable credential (password/noauth),
 *   permanent and made terminal by the `shouldRetry` veto for a static token that cannot be refreshed.
 *
 * Teardown is idempotent and state-gated: it sends a namespace DISCONNECT (`41/log,`) only when the socket is still OPEN, ALWAYS issues `close(1000)`, clears the
 * watchdog, and settles the parked stdout waiter exactly once. The class introduces NO `Clock` dependency - reconnect timing is exercised in tests by injecting a
 * near-zero `backoff`, and the watchdog by `node:test` `mock.timers`.
 *
 * @module
 */
import { DEFAULT_PORT, JITTER_FRACTION, LOG_NAMESPACE, MARGIN_MS, PTY_COLUMNS, PTY_ROWS, RECONNECT_BASE_MS, RECONNECT_CAP_MS } from "./settings.ts";
import { HbpuAbortError, Watchdog, composeSignals, formatErrorMessage, onAbort, retry } from "../util.ts";
import { LOG_NAMESPACE_PATH, decodeFrame, encodeFrame } from "./frame.ts";
import { LogAuthError, isPermanentAuthError } from "./auth.ts";
import type { HomebridgePluginLogging } from "../util.ts";
import { LogLineSplitter } from "./parser.ts";
import { socketUrl } from "./endpoints.ts";

// The default high-water mark for the stdout queue: the maximum number of lines buffered between the WebSocket producer and a slow consumer before the oldest lines are
// dropped. A live consumer (a terminal, a grep) keeps up in practice, so this bound is a safety valve against an unbounded backlog rather than a routine limit; it is
// generous enough to absorb the server's ~500-line seed plus normal jitter, and overflow is logged once so a chronically-slow consumer is not silently lossy.
const DEFAULT_STDOUT_HIGH_WATER = 10000;

/**
 * A minimal WebSocket surface the {@link LogSocket} depends on, so the concrete implementation (the platform global `WebSocket`, or a test double) is an injected seam.
 *
 * The shape is the subset of the DOM `WebSocket` interface the socket actually uses: the four lifecycle events via `addEventListener`, `send` for outbound frames,
 * `close` for teardown, and `readyState` (compared against {@link WEBSOCKET_OPEN}) so teardown can gate the namespace-disconnect frame on an open connection. Modeling
 * the seam as this narrow interface rather than the full `WebSocket` keeps a test double small and makes the socket's exact dependency surface explicit.
 *
 * @category Log Client
 */
export interface WebSocketLike {

  addEventListener(type: "close", listener: (event: { readonly code: number }) => void): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
  addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
  addEventListener(type: "open", listener: () => void): void;
  close(code?: number): void;
  readonly readyState: number;
  send(data: string): void;
}

/**
 * The factory seam that constructs a {@link WebSocketLike} for a given connect URL.
 *
 * The production factory wraps the platform global `WebSocket`; a test substitutes a factory that returns a controllable double, so the whole socket state machine -
 * handshake, ping/pong, reconnect, teardown - is exercised without a real network.
 *
 * @param url - The fully-formed `ws(s)://...` connect URL, already carrying `EIO=4`, the transport selector, and the raw token in its query string.
 *
 * @returns A {@link WebSocketLike} that begins connecting immediately, exactly as the platform `WebSocket` constructor does.
 *
 * @category Log Client
 */
export type WebSocketFactory = (url: string) => WebSocketLike;

/**
 * Re-acquire a fresh raw bearer token. Invoked once per connect attempt so a reconnect after a token has expired re-authenticates from the stored credentials. The
 * provider may reject with a permanent authentication failure, which the reconnect loop classifies terminal via {@link isPermanentAuthError}.
 *
 * @param signal - The connect attempt's abort signal, forwarded so a token acquisition in flight is cancelled when the attempt is aborted.
 *
 * @returns A promise resolving to the raw bearer token (the bare JWT, no `Bearer` prefix).
 *
 * @category Log Client
 */
export type TokenProvider = (signal: AbortSignal) => Promise<string>;

/**
 * The numeric `readyState` value denoting an open WebSocket. The DOM `WebSocket.OPEN` constant is `1`; we name it as a module constant so the seam interface does not
 * have to carry the static constant and teardown can gate on it without depending on the concrete class.
 *
 * @category Log Client
 */
export const WEBSOCKET_OPEN = 1;

/**
 * The production {@link WebSocketFactory}: constructs the platform global `WebSocket`. A consumer holds the factory typed as the seam abstraction; a test substitutes a
 * double. The platform `WebSocket` begins connecting on construction, which is exactly the factory contract.
 *
 * @param url - The connect URL.
 *
 * @returns A live platform `WebSocket`, typed as the {@link WebSocketLike} seam.
 *
 * @category Log Client
 */
export const webSocketFactory: WebSocketFactory = (url: string): WebSocketLike => new WebSocket(url);

/**
 * Construction-time options for {@link LogSocket}.
 *
 * @property backoff          - Optional override for the connect-phase backoff policy, invoked with the 1-indexed attempt about to run and returning the delay in
 *                              milliseconds. Defaults to the log client's own jittered exponential curve - a `RECONNECT_BASE_MS` base doubling each attempt and
 *                              capped at `RECONNECT_CAP_MS`, plus up to `JITTER_FRACTION` upward jitter. Overridden in tests with a near-zero delay so the
 *                              reconnect loop runs without real waits.
 * @property host             - The hostname or IP of the homebridge-config-ui-x server.
 * @property log              - Logger for connection lifecycle and overflow diagnostics.
 * @property port             - The TCP port the server listens on. Defaults to `8581`.
 * @property random           - Injectable source of `[0, 1)` randomness for backoff jitter. Defaults to `Math.random`; pinned in tests for deterministic backoff.
 * @property refreshable      - Whether the credential backing {@link LogSocketInit.tokenProvider} can mint a fresh token on a reconnect. `true` for `password`/`noauth`
 *                              credentials (each connect re-authenticates), `false` for a static `token`. When `false`, a handshake/namespace auth rejection is raised as
 *                              a permanent {@link LogAuthError} so the connect-phase retry veto makes it terminal rather than retrying a token that cannot be refreshed.
 * @property signal           - Optional parent {@link AbortSignal} composed with the socket's internal controller. When the parent aborts, the socket tears down.
 * @property stdoutHighWater  - Optional high-water mark for the bounded stdout queue. Defaults to `10000`. Overflow drops the oldest lines.
 * @property tls              - When `true`, use the secure (`wss`) scheme; when `false` or omitted, plaintext (`ws`).
 * @property tokenProvider    - Re-acquires a fresh token per connect attempt. See {@link TokenProvider}.
 * @property webSocketFactory - The factory that constructs the underlying WebSocket. Defaults to {@link webSocketFactory}.
 *
 * @category Log Client
 */
export interface LogSocketInit {

  readonly backoff?: (attempt: number) => number;
  readonly host: string;
  readonly log: HomebridgePluginLogging;
  readonly port?: number;
  readonly random?: () => number;
  readonly refreshable: boolean;
  readonly signal?: AbortSignal;
  readonly stdoutHighWater?: number;
  readonly tls?: boolean;
  readonly tokenProvider: TokenProvider;
  readonly webSocketFactory?: WebSocketFactory;
}

// Add up-to-`JITTER_FRACTION` upward random jitter to a base delay. Jitter spreads reconnect attempts so a fleet of clients does not stampede the server in lockstep
// after a shared outage. The `random` source is injected so the jittered delay is deterministic in tests; with `random` pinned near zero the delay is effectively the
// base, which is how the reconnect tests drive the loop without real waits.
function withJitter(base: number, random: () => number): number {

  return Math.round(base + (base * JITTER_FRACTION * random()));
}

/**
 * The log client's connect-phase reconnect backoff policy: a dev-tuned jittered exponential curve with a low ceiling.
 *
 * This is the single source of truth for the socket's default reconnect timing. The base delay is `RECONNECT_BASE_MS` (500 ms) and it doubles with each successive
 * connect attempt, plateauing at the `RECONNECT_CAP_MS` ceiling (5 s) - deliberately snappier than `defaultRetryBackoff`'s 30-second ceiling, because a log-tailing
 * dev tool should resume the tail promptly after the frequent Homebridge restarts a plugin developer does rather than back off to a half-minute lag. Up to
 * `JITTER_FRACTION` of the computed base is added as upward jitter so a fleet of clients does not reconnect in lockstep after a shared outage.
 *
 * It is exported (rather than left inline in the constructor) so the bare schedule is a directly unit-testable function: with `random` pinned to `0` the curve yields the
 * exact, deterministic 500, 1000, 2000, 4000, 5000, 5000, ... sequence. `retry` invokes the socket's backoff 1-indexed with the attempt about to run and never with
 * `attempt === 1` (the first attempt runs immediately), so `attempt - 2` is the zero-based exponent for the second-and-later attempts.
 *
 * @param attempt - The 1-indexed connect attempt about to run. Called only for the second and later attempts (the first runs with no wait).
 * @param random  - Source of `[0, 1)` randomness for the jitter. Defaults to `Math.random`; pinned in tests for a deterministic schedule.
 *
 * @returns The delay, in milliseconds, to wait before running `attempt`.
 *
 * @category Log Client
 */
export function reconnectBackoff(attempt: number, random: () => number = Math.random): number {

  return withJitter(Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * (2 ** (attempt - 2))), random);
}

// A single connected session: the live WebSocket, the per-session controller whose signal ends the streaming phase, the ping cadence the Engine.IO open handshake
// advertised (used to size the liveness watchdog), and a one-shot `closed` latch. The controller is composed under the socket's lifetime signal, so a socket-level abort
// ends the session too; a session-level abort (close, error, watchdog) ends only this session and lets the outer loop reconnect. The `closed` latch makes the WebSocket
// teardown idempotent: both the streaming phase's post-end cleanup and the socket-level teardown can race to close the same session, and the latch ensures the
// DISCONNECT-and-close sequence runs exactly once rather than twice.
interface Session {

  closed: boolean;
  readonly controller: AbortController;
  readonly pingInterval: number;
  readonly pingTimeout: number;
  readonly ws: WebSocketLike;
}

/**
 * The consumer-facing surface of a live-log socket: the minimal interface a client reads off a {@link LogSocket}. This is the product half of the socket
 * dependency-inversion seam, so a client depends on this narrow interface rather than the concrete {@link LogSocket} and a test can substitute a fake that yields
 * caller-supplied lines without standing up a WebSocket. Every member is defined on {@link LogSocket}, so the real class satisfies it by `implements` with zero runtime
 * change.
 *
 * @category Log Client
 */
export interface LogSocketLike extends AsyncDisposable {

  /**
   * Abort the socket and tear it down. Defaults to `HbpuAbortError("shutdown")` when no reason is supplied.
   *
   * @param reason - Optional abort reason. Typically an {@link HbpuAbortError}.
   */
  abort(reason?: unknown): void;

  /**
   * `true` once the socket's lifetime signal has aborted.
   */
  readonly aborted: boolean;

  /**
   * The number of stdout lines dropped because the consumer fell behind the high-water mark. Zero in steady state.
   */
  readonly droppedLines: number;

  /**
   * The composed abort signal representing the socket's lifetime. Aborts exactly once; the reason on `signal.reason` names the cause.
   */
  readonly signal: AbortSignal;

  /**
   * The bounded push-to-pull stream of raw log lines the server streams over the log namespace. Terminates when the socket aborts.
   *
   * @returns An async generator yielding raw log lines in stream order.
   */
  stdout(): AsyncGenerator<string>;
}

/**
 * The creational half of the socket dependency-inversion seam: build a {@link LogSocketLike} from the socket init. A client holds this factory typed as the abstraction
 * and constructs through it, so a test can substitute a factory that returns a fake socket. The production factory is {@link logSocketFactory}, whose `create` is exactly
 * the {@link LogSocket} constructor call, so routing construction through this seam is behavior-neutral - mirroring the `RecordingProcessFactory` precedent.
 *
 * @category Log Client
 */
export interface LogSocketFactory {

  /**
   * Construct a live-log socket for the supplied init.
   *
   * @param init - The socket init options. See {@link LogSocketInit}.
   *
   * @returns A new {@link LogSocketLike}.
   */
  create(init: LogSocketInit): LogSocketLike;
}

/**
 * AsyncDisposable client for the live Homebridge log stream over a single Socket.IO WebSocket, with automatic reconnect, ping liveness, and a bounded push-to-pull line
 * stream.
 *
 * @example
 *
 * ```ts
 * await using socket = new LogSocket({
 *
 *   host: "localhost",
 *   log,
 *   refreshable: true,
 *   tokenProvider: (signal) => acquireToken(credentials, { host: "localhost", port: 8581, signal }),
 *   signal: session.signal
 * });
 *
 * for await (const line of socket.stdout()) {
 *
 *   process.stdout.write(line + "\n");
 * }
 * ```
 *
 * @category Log Client
 */
export class LogSocket implements LogSocketLike {

  /**
   * The composed abort signal representing this socket's lifetime. Aborts exactly once - when {@link LogSocket.abort} is called, the parent signal fires, or the
   * reconnect loop gives up on a permanent failure - and `signal.reason` names the cause.
   */
  public readonly signal: AbortSignal;

  // The private controller whose signal is composed into `this.signal`. Owned internally so the only abort verb is `abort()`.
  readonly #controller: AbortController;

  readonly #backoff: (attempt: number) => number;
  readonly #host: string;
  readonly #log: HomebridgePluginLogging;
  readonly #port: number;
  readonly #random: () => number;
  readonly #refreshable: boolean;
  readonly #stdoutHighWater: number;
  readonly #tls: boolean;
  readonly #tokenProvider: TokenProvider;
  readonly #webSocketFactory: WebSocketFactory;

  // The bounded queue of raw stdout lines staged for the `stdout()` consumer, plus the single parked waiter the consumer blocks on when the queue is empty. The class is
  // single-consumer by design, mirroring `Mp4SegmentAssembler`: one parked-waiter slot is sufficient.
  #stdoutQueue: string[] = [];
  #stdoutWaiter: PromiseWithResolvers<void> | undefined;

  // The number of lines dropped because the stdout queue hit its high-water mark, and a one-time flag so a chronically-slow consumer is warned exactly once rather than
  // on every drop. Tracking the count lets the single warning report the magnitude of the loss.
  #droppedLines = 0;
  #overflowLogged = false;

  // The background reconnect loop's promise, retained so `[Symbol.asyncDispose]` can await its completion before returning.
  #loopTask: Promise<void> | undefined;

  // The current live session, or `undefined` between sessions / after teardown. Held so teardown can close the live WebSocket and so the message handler can address the
  // correct connection's `send`.
  #session: Session | undefined;

  /**
   * Construct and start a new live-log socket. The reconnect loop starts synchronously as part of construction: by the time the constructor returns, the first connect
   * attempt is already in flight (unless the signal was pre-aborted, in which case the socket tears down immediately).
   *
   * @param init - Required init options. See {@link LogSocketInit}.
   */
  public constructor(init: LogSocketInit) {

    this.#host = init.host;
    this.#log = init.log;
    this.#port = init.port ?? DEFAULT_PORT;
    this.#random = init.random ?? Math.random;
    this.#refreshable = init.refreshable;
    this.#stdoutHighWater = init.stdoutHighWater ?? DEFAULT_STDOUT_HIGH_WATER;
    this.#tls = init.tls ?? false;
    this.#tokenProvider = init.tokenProvider;
    this.#webSocketFactory = init.webSocketFactory ?? webSocketFactory;

    // The connect-phase backoff. Defaults to the log client's own jittered exponential curve via {@link reconnectBackoff} - a 500 ms base doubling each attempt and
    // plateauing at a 5-second ceiling, deliberately snappier than `defaultRetryBackoff`'s 30-second ceiling because a dev tool should resume the tail promptly after the
    // frequent Homebridge restarts a plugin developer does. A caller (a test) may inject a near-zero policy to drive the reconnect loop without real waits. Resolved once
    // here, closing over the socket's injected `random`, so the hot reconnect path reads a single field rather than re-deriving the default each attempt.
    this.#backoff = init.backoff ?? ((attempt: number): number => reconnectBackoff(attempt, this.#random));

    this.#controller = new AbortController();
    this.signal = composeSignals(init.signal, this.#controller.signal);

    // Single teardown convergence point. `onAbort` registers the one-shot teardown for the normal abort path AND runs it inline when the signal is already aborted at
    // construction time (a pre-aborted parent), so the stdout waiter is settled and the live connection closed regardless of which path fired.
    onAbort(this.signal, () => this.#teardown());

    if(this.signal.aborted) {

      return;
    }

    // Start the background reconnect loop. The returned promise is retained so disposal can await its completion; the loop is written to always resolve (it classifies
    // its own faults), so no `markHandled` wrapper is needed.
    this.#loopTask = this.#runLoop();
  }

  /**
   * Abort the socket and tear it down. Defaults to `HbpuAbortError("shutdown")` when no reason is supplied; explicit reasons pass through unchanged.
   *
   * Safe to call more than once: the underlying signal aborts only once, so subsequent calls are no-ops.
   *
   * @param reason - Optional abort reason. Typically an {@link HbpuAbortError}.
   */
  public abort(reason?: unknown): void {

    if(this.aborted) {

      return;
    }

    this.#controller.abort(reason ?? new HbpuAbortError("shutdown"));
  }

  /**
   * `AsyncDisposable` implementation. Aborts the socket (defaulting to `"shutdown"`) and awaits the reconnect loop's completion before returning, so callers using
   * `await using` are guaranteed the connection is closed and the loop has unwound by the time the block exits.
   *
   * @returns A promise that resolves once the reconnect loop has fully exited.
   */
  public async [Symbol.asyncDispose](): Promise<void> {

    this.abort();

    if(this.#loopTask) {

      // The loop is written to always resolve; the catch is belt-and-suspenders so disposal never surfaces a cleanup-side failure the caller cannot react to.
      await this.#loopTask.catch(() => { /* Cleanup swallows outcome. */ });
    }
  }

  /**
   * `true` once `this.signal` has aborted. Derived from the signal; no independent state.
   */
  public get aborted(): boolean {

    return this.signal.aborted;
  }

  /**
   * The number of stdout lines dropped so far because the consumer fell behind the high-water mark. Zero in steady state; non-zero only after the bounded queue
   * overflowed, which is also logged once.
   */
  public get droppedLines(): number {

    return this.#droppedLines;
  }

  /**
   * The bounded push-to-pull stream of raw log lines (ANSI intact, terminators removed) the server streams over the log namespace's `stdout` events.
   *
   * The server delivers `stdout` as raw text chunks whose boundaries do not align with log lines; the socket runs each chunk through a per-session
   * {@link LogLineSplitter}, yields complete lines here, and flushes it on each session's close so the final line is never stranded. Mirroring
   * `Mp4SegmentAssembler.segments`, a bounded queue decouples the WebSocket producer from this consumer, and a single parked waiter blocks the consumer when the queue is
   * empty until a line is pushed or the socket aborts. The queue survives reconnects - the same iterable keeps yielding across a drop-and-reconnect - so a consumer
   * iterates it once for the whole socket lifetime. The stream terminates (returns) when the socket aborts; the queue is drained before it returns, so a line already
   * staged before teardown is never lost.
   *
   * **Single-consumer only.** The parked-waiter slot is single-writer; iterating `stdout()` concurrently from two consumers is unsupported.
   *
   * @returns An async generator yielding raw log lines in stream order.
   */
  public async *stdout(): AsyncGenerator<string> {

    for(;;) {

      // Swap-drain the queue: take whatever the producer has staged, leave a fresh empty array for it to push into, then yield the snapshot. Draining unconditionally
      // before the abort check preserves the "no staged line lost on teardown" invariant.
      while(this.#stdoutQueue.length > 0) {

        const drained = this.#stdoutQueue;

        this.#stdoutQueue = [];

        for(const line of drained) {

          yield line;
        }
      }

      if(this.signal.aborted) {

        return;
      }

      // Park until a line is pushed (producer resolves the waiter) or the socket aborts (teardown resolves it). A per-iteration resolver keeps the waiter always fresh.
      const waiter: PromiseWithResolvers<void> = Promise.withResolvers();

      this.#stdoutWaiter = waiter;

      // `onAbort` unifies registration, the pre-aborted-signal pitfall, and one-shot `{ once: true }` semantics; the disposer is handed to `using` so the listener is
      // removed on every scope-exit path. Matches the parked-wait shape `Mp4SegmentAssembler` uses.
      using _abortRegistration = onAbort(this.signal, () => waiter.resolve());

      try {

        // eslint-disable-next-line no-await-in-loop
        await waiter.promise;
      } finally {

        this.#stdoutWaiter = undefined;
      }
    }
  }

  // The background reconnect loop. Runs for the socket's lifetime: each iteration `retry()`s the connect phase to obtain a live session, then streams until the session
  // ends. A clean socket-level abort exits the loop; any other session end loops again, and because only the connect phase is wrapped in `retry`, the next attempt
  // starts from a fresh (reset) backoff curve.
  async #runLoop(): Promise<void> {

    while(!this.signal.aborted) {

      let session: Session;

      try {

        // Connect phase only. `retry` owns the backoff and the permanent-failure veto; `Infinity` attempts means the loop reconnects indefinitely until the socket is
        // aborted or a permanent failure is vetoed. The default backoff is the log client's own dev-tuned exponential curve (a 500 ms base doubling each attempt and
        // capped at a 5-second ceiling, snappier than `defaultRetryBackoff`'s 30-second ceiling) with up-to-`JITTER_FRACTION` upward jitter layered on, so a fleet of
        // clients does not stampede the server in lockstep after a shared outage. Because only the connect phase is wrapped, the backoff resets every time this returns -
        // a socket that stayed healthy for hours reconnects briskly rather than at a climbed-up delay.
        // eslint-disable-next-line no-await-in-loop
        session = await retry((attemptSignal) => this.#connect(attemptSignal), {

          attempts: Infinity,
          backoff: this.#backoff,
          shouldRetry: (error) => !isPermanentAuthError(error),
          signal: this.signal
        });
      } catch(error: unknown) {

        // The connect phase exhausted its retries or hit a permanent failure (a vetoed auth error), or the socket was aborted mid-connect. When the socket is already
        // aborted, this is orderly teardown - stay quiet and exit. Otherwise classify the connection as permanently failed, abort the socket so `stdout()` terminates,
        // and surface an actionable error. The signal's aborted state changes asynchronously while `await retry(...)` is in flight, so the loop-condition narrowing the
        // compiler applies here does not reflect the runtime value.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if(this.signal.aborted) {

          return;
        }

        this.#log.error("Unable to connect to the Homebridge log stream: %s.", formatErrorMessage(error));
        this.#controller.abort(new HbpuAbortError("failed", { cause: error }));

        return;
      }

      // Stream until the session ends (peer close, error, watchdog timeout, or socket abort). When it returns, loop to reconnect unless the socket itself was aborted.
      // eslint-disable-next-line no-await-in-loop
      await this.#stream(session);
    }
  }

  // Connect phase. Re-acquires a fresh token, opens the WebSocket, awaits the Engine.IO open handshake (capturing its ping cadence), joins the `/log` namespace, and
  // emits `tail-log`. Resolves with the live session once `tail-log` has been emitted; rejects on any handshake fault (WebSocket error, CONNECT_ERROR, peer close, or
  // attempt abort), so `retry` governs the backoff. A per-attempt controller composed under the attempt signal ensures a failed attempt's WebSocket and listeners are
  // torn down before the next attempt opens a new one; on success that same controller becomes the session controller, so the streaming phase shares the teardown path.
  async #connect(attemptSignal: AbortSignal): Promise<Session> {

    const token = await this.#tokenProvider(attemptSignal);
    const url = socketUrl({ host: this.#host, port: this.#port, tls: this.#tls, token });

    const controller = new AbortController();
    const composed = composeSignals(attemptSignal, controller.signal);
    const ws = this.#webSocketFactory(url);

    // Capture the Engine.IO open handshake's ping cadence so the streaming phase can size the liveness watchdog from the server's real cadence rather than a guess.
    let pingInterval = 0;
    let pingTimeout = 0;

    // The connect handshake is a one-shot promise resolved by the message handler once `tail-log` has been emitted, or rejected by an error / close / CONNECT_ERROR /
    // abort.
    const { promise: connected, resolve, reject }: PromiseWithResolvers<void> = Promise.withResolvers();

    // Tear down this attempt's WebSocket when the composed signal aborts (attempt abort or our own controller abort), and reject the connect promise so a pending
    // handshake unwinds. The `using` disposer removes the listener when this method's scope exits.
    using _abortRegistration = onAbort(composed, () => {

      reject(composed.reason);
      this.#closeWebSocket(ws);
    });

    ws.addEventListener("error", (event: unknown) => {

      reject(new HbpuAbortError("failed", { cause: this.#describeWsError(event) }));
    });

    ws.addEventListener("close", (event: { readonly code: number }) => {

      // A close during the connect handshake is a connect-phase failure (the server hung up before we finished joining the namespace); reject so `retry` backs off.
      reject(new HbpuAbortError("closed", { cause: { code: event.code } }));
    });

    ws.addEventListener("message", (event: { readonly data: unknown }) => {

      if(typeof event.data !== "string") {

        return;
      }

      const decoded = decodeFrame(event.data);

      switch(decoded.kind) {

        case "open": {

          // The Engine.IO handshake. Record the ping cadence and join the `/log` namespace; the server replies with a namespace CONNECT acknowledgement (or a
          // CONNECT_ERROR).
          pingInterval = decoded.pingInterval;
          pingTimeout = decoded.pingTimeout;
          ws.send(encodeFrame({ kind: "connect", namespace: LOG_NAMESPACE }));

          return;
        }

        case "namespaceConnect": {

          // The namespace is joined. Request the tail with the advertised PTY geometry, then consider the handshake complete - from here the server streams `stdout`.
          ws.send(encodeFrame({ args: { cols: PTY_COLUMNS, rows: PTY_ROWS }, event: "tail-log", kind: "event", namespace: LOG_NAMESPACE }));
          resolve();

          return;
        }

        case "namespaceError": {

          // The server rejected the namespace join (a Socket.IO CONNECT_ERROR, commonly an auth failure on a stale or invalid token). How we classify it depends on
          // whether the backing credential can mint a fresh token on the next attempt. With a refreshable credential (password/noauth) the next reconnect re-auths from
          // the stored credentials, so this is a transient connect-phase failure and we surface it as a plain `HbpuAbortError("failed")` that `retry` governs. With
          // a static `token` credential there is nothing to refresh, so retrying the same rejected token would loop forever; we raise a PERMANENT `LogAuthError` instead,
          // so the connect-phase `shouldRetry` veto (`!isPermanentAuthError`) makes the socket fail fast with an actionable error rather than spinning on a doomed token.
          if(this.#refreshable) {

            reject(new HbpuAbortError("failed", { cause: { reason: decoded.reason } }));

            return;
          }

          reject(new LogAuthError("Authentication rejected; the token cannot be refreshed - provide a fresh --token or use --user/--pass.",
            { cause: { reason: decoded.reason }, kind: "permanent" }));

          return;
        }

        default: {

          // ping/pong/message/unknown during the handshake are not part of the connect sequence; ignore them. The server does not stream `stdout` until `tail-log` is
          // emitted, so a `message` before that is not expected, but ignoring it is harmless.

          return;
        }
      }
    });

    // Await the handshake. On any failure path - a WebSocket error, a CONNECT_ERROR, a peer close mid-handshake, or an attempt abort - close this attempt's WebSocket so
    // a failed attempt never leaks its connection before `retry` opens the next one. The `using` abort registration handles the abort path's close; this catch covers
    // the listener-driven rejections (error / close / CONNECT_ERROR) where the composed signal did not abort.
    try {

      await connected;
    } catch(error: unknown) {

      this.#closeWebSocket(ws);

      throw error;
    }

    return { closed: false, controller, pingInterval, pingTimeout, ws };
  }

  // Streaming phase. The session is connected; split `stdout` chunks into lines and route them into the bounded queue, answer pings with pongs and re-arm the liveness
  // watchdog, and end the session on close / error / watchdog timeout. Resolves when the session's signal aborts - which the outer loop reads to decide whether to
  // reconnect. The watchdog window is sized from the server's advertised ping cadence plus a margin; the watchdog uses real timers (no `Clock` seam), so tests drive it
  // with `mock.timers`.
  async #stream(session: Session): Promise<void> {

    this.#session = session;

    const composed = composeSignals(this.signal, session.controller.signal);

    // The per-session line splitter. The server delivers `stdout` events as raw text chunks whose boundaries do not align with log lines; the splitter reassembles lines
    // across chunk boundaries and normalizes the mixed newline conventions. It is per-session (a fresh connection starts with a clean carry) and is flushed on session
    // close so the final line - which the splitter withholds when a chunk ends on a lone line-feed pending a possible cross-chunk pair - surfaces rather than stranding.
    const splitter = new LogLineSplitter();

    // The liveness watchdog, sized from the server's advertised ping cadence captured during the connect handshake: one ping interval plus the ping timeout plus a fixed
    // margin, so a single late ping does not trip it. A zero/absent cadence (malformed handshake) falls back to the margin alone. Each inbound ping re-arms it; if the
    // window lapses with no ping, it aborts the SESSION (not the whole socket), so the outer loop reconnects. The watchdog uses real timers (no `Clock` seam), so tests
    // drive its firing with `node:test` `mock.timers`.
    const windowMs = ((session.pingInterval > 0) ? session.pingInterval : 0) + ((session.pingTimeout > 0) ? session.pingTimeout : 0) + MARGIN_MS;
    const watchdog = new Watchdog({ onFire: (): void => session.controller.abort(new HbpuAbortError("timeout")), signal: composed, timeoutMs: windowMs });

    // A single resolver settled when the session ends so this method awaits the session lifetime without a busy loop. `onAbort` settles it on session abort; the message
    // and close handlers drive the session controller, which aborts the composed signal, which fires this.
    const { promise: ended, resolve: endSession }: PromiseWithResolvers<void> = Promise.withResolvers();

    using _watchdog = watchdog;
    using _abortRegistration = onAbort(composed, () => endSession());

    // Arm the watchdog immediately so a session that never receives a single ping (a silently-wedged connection) still trips the liveness timer; each inbound ping
    // re-arms it from here.
    watchdog.arm();

    session.ws.addEventListener("message", (event: { readonly data: unknown }) => {

      this.#handleStreamMessage(session, watchdog, splitter, event.data);
    });

    session.ws.addEventListener("close", (event: { readonly code: number }) => {

      // The peer closed the connection. End the session with `"closed"` so the outer loop reconnects (the socket-level signal is untouched, so this is a session end,
      // not a socket end).
      if(!session.controller.signal.aborted) {

        session.controller.abort(new HbpuAbortError("closed", { cause: { code: event.code } }));
      }
    });

    session.ws.addEventListener("error", (event: unknown) => {

      if(!session.controller.signal.aborted) {

        session.controller.abort(new HbpuAbortError("failed", { cause: this.#describeWsError(event) }));
      }
    });

    await ended;

    // Flush the splitter on session end so the final line - withheld by the splitter when the last chunk ended on a lone line-feed pending a possible cross-chunk pair -
    // surfaces rather than stranding. This is the load-bearing flush the wiring note calls for; mid-stream the next chunk drains the carry, but at session close no next
    // chunk arrives.
    for(const line of splitter.flush()) {

      this.#enqueueStdout(line);
    }

    // Tear down the session's WebSocket on the way out: send the namespace DISCONNECT only when still OPEN, then always close(1000). Clearing `#session` prevents a stale
    // reference from leaking into the next iteration's teardown.
    this.#closeSession(session);

    if(this.#session === session) {

      this.#session = undefined;
    }
  }

  // Handle a message in the streaming phase. A ping is answered with a pong and re-arms the liveness watchdog (each ping is the server's heartbeat). A `stdout` message's
  // payload is a raw log-text chunk; it is fed through the per-session splitter and every complete line it yields is enqueued for the consumer (the server's chunk
  // boundaries do not align with log lines, so splitting must happen here, before the bounded queue).
  #handleStreamMessage(session: Session, watchdog: Watchdog, splitter: LogLineSplitter, data: unknown): void {

    if(typeof data !== "string") {

      return;
    }

    const event = decodeFrame(data);

    switch(event.kind) {

      case "ping": {

        // Answer the heartbeat and re-arm the liveness watchdog. Re-arming on each ping is the liveness contract: as long as pings keep arriving, the watchdog never
        // fires.
        session.ws.send(encodeFrame({ kind: "pong" }));
        watchdog.arm();

        return;
      }

      case "message": {

        // A namespace event. The log stream's only event is `stdout`, whose payload is a raw text chunk; split it into lines and enqueue each for the consumer. Any other
        // event name is ignored.
        if((event.event === "stdout") && (typeof event.payload === "string")) {

          for(const line of splitter.consume(event.payload)) {

            this.#enqueueStdout(line);
          }
        }

        return;
      }

      default: {

        // open / pong / namespaceConnect / namespaceError / unknown in the streaming phase are not actionable here; ignore them.

        return;
      }
    }
  }

  // Enqueue a complete log line for the `stdout()` consumer, enforcing the high-water bound. When the queue is at capacity the OLDEST line is dropped (a live tail cares
  // about recent output, not stale backlog), the drop counter is incremented, and a single warning is logged so a chronically-slow consumer learns it is lossy without
  // the log being flooded. Resolving the parked waiter wakes a blocked consumer.
  #enqueueStdout(line: string): void {

    if(this.#stdoutQueue.length >= this.#stdoutHighWater) {

      this.#stdoutQueue.shift();
      this.#droppedLines++;

      if(!this.#overflowLogged) {

        this.#overflowLogged = true;
        this.#log.warn("The Homebridge log stream is producing output faster than it is being consumed; the oldest buffered lines are being dropped.");
      }
    }

    this.#stdoutQueue.push(line);
    this.#stdoutWaiter?.resolve();
  }

  // Render a WebSocket `"error"` event for diagnostics. The DOM error event carries no structured detail; a Node `ws` error event may carry an `error` field. We surface
  // whichever is present, falling back to a generic label, so the abort cause is at least minimally informative.
  #describeWsError(event: unknown): unknown {

    if((typeof event === "object") && (event !== null) && ("error" in event)) {

      return event.error;
    }

    return new Error("WebSocket connection error.");
  }

  // Close a session's WebSocket cleanly: send the namespace DISCONNECT (`41/log,`) only when the connection is still OPEN, then ALWAYS issue `close(1000)`. Idempotent
  // via the session's one-shot `closed` latch - both the streaming phase's post-end cleanup and the socket-level teardown can reach the same live session, and the latch
  // ensures the DISCONNECT-and-close sequence runs exactly once. The readyState gate avoids a send on a half-closed connection; the unconditional close is the teardown
  // invariant.
  #closeSession(session: Session): void {

    if(session.closed) {

      return;
    }

    session.closed = true;

    if(session.ws.readyState === WEBSOCKET_OPEN) {

      try {

        session.ws.send("41" + LOG_NAMESPACE_PATH + ",");
      } catch {

        // A send on a connection that closed between the readyState check and here is harmless; the close below is what matters.
      }
    }

    this.#closeWebSocket(session.ws);
  }

  // Issue the orderly WebSocket close, swallowing any throw (closing an already-closed or still-connecting socket can throw on some platforms). `close(1000)` is the
  // normal-closure code; teardown always sends it so the server sees a clean disconnect.
  #closeWebSocket(ws: WebSocketLike): void {

    try {

      ws.close(1000);
    } catch {

      // Closing a socket that is already closed (or in a state where close throws) is a no-op for our purposes.
    }
  }

  // Single teardown convergence point, fired exactly once when `this.signal` aborts. Closes the live session's WebSocket (sending the namespace DISCONNECT if OPEN, then
  // always close(1000)) and settles the parked stdout waiter so the consumer's `stdout()` generator wakes, drains the queue, and returns. The reconnect loop observes the
  // aborted signal and exits on its next iteration boundary; the watchdog self-cleans through its own composed-signal listener.
  #teardown(): void {

    if(this.#session !== undefined) {

      this.#closeSession(this.#session);
      this.#session = undefined;
    }

    this.#stdoutWaiter?.resolve();
  }
}

/**
 * The production {@link LogSocketFactory}: builds the concrete WebSocket-backed {@link LogSocket}. A client holds the factory typed as the seam abstraction; a test
 * substitutes a fake factory. `create` is exactly the {@link LogSocket} constructor call, so wiring construction through this seam is behavior-neutral.
 *
 * @category Log Client
 */
export const logSocketFactory: LogSocketFactory = {

  create: (init: LogSocketInit): LogSocketLike => new LogSocket(init)
};
