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
 * Teardown is safe to repeat and state-gated: it sends a namespace DISCONNECT (`41/log,`) only when the socket is still OPEN and ALWAYS issues `close(1000)`; the
 * session's watchdog self-disposes through its own composed-signal listener rather than through teardown. One optional
 * {@link Clock} carries both of the socket's timing concerns - the per-session liveness window and the reconnect backoff - so a test injects a `TestClock` and drives
 * the whole reconnect-and-liveness story from one lever, while the backoff shape stays independently steerable through the injected `backoff` policy.
 *
 * @module
 */
import { Agent, WebSocket } from "undici";
import { DEFAULT_PORT, JITTER_FRACTION, LOG_NAMESPACE, MARGIN_MS, PTY_COLUMNS, PTY_ROWS, RECONNECT_BASE_MS, RECONNECT_CAP_MS } from "./settings.ts";
import {

  HbpuAbortError,
  Watchdog,
  assertPositiveInteger,
  composeSignals,
  exponentialBackoff,
  formatErrorMessage,
  markHandled,
  onAbort,
  repeatDemotedLog,
  retry
} from "../util.ts";
import type { HomebridgePluginLogging, RepeatDemotedLog } from "../util.ts";
import { LOG_NAMESPACE_PATH, decodeFrame, encodeFrame } from "./frame.ts";
import { LogAuthError, isPermanentAuthError } from "./auth.ts";
import { AsyncQueue } from "../async-queue.ts";
import type { Clock } from "../clock.ts";
import type { Dispatcher } from "undici";
import { LogLineSplitter } from "./parser.ts";
import type { OwnedConnector } from "../owned-connector.ts";
import type { TransportFailureKind } from "../transport-error.ts";
import { classifyTransportError } from "../transport-error.ts";
import { createOwnedConnector } from "../owned-connector.ts";
import { socketUrl } from "./endpoints.ts";

// The default high-water mark for the stdout queue: the maximum number of lines buffered between the WebSocket producer and a slow consumer before the oldest lines are
// dropped. A live consumer (a terminal, a grep) keeps up in practice, so this bound is a safety valve against an unbounded backlog rather than a routine limit; it is
// generous enough to absorb the server's ~500-line seed plus normal jitter, and overflow is logged once so a chronically-slow consumer is not silently lossy.
const DEFAULT_STDOUT_HIGH_WATER = 10000;

/**
 * A minimal WebSocket surface the {@link LogSocket} depends on, so the concrete implementation (the platform global `WebSocket`, or a test double) is an injected
 * dependency.
 *
 * The shape is the subset of the DOM `WebSocket` interface the socket actually uses: the four lifecycle events via `addEventListener`, `send` for outbound frames,
 * `close` for teardown, and `readyState` (compared against {@link WEBSOCKET_OPEN}) so teardown can gate the namespace-disconnect frame on an open connection. Keeping
 * this interface narrow, rather than the full `WebSocket`, keeps a test double small and makes the socket's exact dependency surface explicit.
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
 * The subset of the WebSocket constructor's own options this boundary passes through to whatever factory is wired in.
 *
 * The dispatcher is how a caller decides which sockets the upgrade is dialed over: hand one that dials through a connector you hold, and the socket underneath the
 * handshake is reachable for the whole of the attempt rather than only through the WebSocket's own events.
 *
 * @category Log Client
 */
export interface WebSocketDialInit {

  readonly dispatcher: Dispatcher;
}

/**
 * The factory that constructs a {@link WebSocketLike} for a given connect URL.
 *
 * The production factory wraps undici's own `WebSocket`; a test substitutes a factory that returns a controllable double, so the whole socket state machine -
 * handshake, ping/pong, reconnect, teardown - is exercised without a real network.
 *
 * @param url  - The fully-formed `ws(s)://...` connect URL, already carrying `EIO=4`, the transport selector, and the raw token in its query string.
 * @param init - The dial options this boundary passes to the constructor. A factory is free to ignore what it does not need, which is what a double that never
 *               reaches the network does.
 *
 * @returns A {@link WebSocketLike} that begins connecting immediately, exactly as the `WebSocket` constructor does.
 *
 * @category Log Client
 */
export type WebSocketFactory = (url: string, init: WebSocketDialInit) => WebSocketLike;

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
 * The numeric `readyState` value denoting an open WebSocket. The DOM `WebSocket.OPEN` constant is `1`; we name it as a module constant so the {@link WebSocketLike}
 * interface does not have to carry the static constant and teardown can gate on it without depending on the concrete class.
 *
 * @category Log Client
 */
export const WEBSOCKET_OPEN = 1;

/**
 * The production {@link WebSocketFactory}: constructs undici's own `WebSocket`. A consumer holds the factory typed as the {@link WebSocketFactory} abstraction; a
 * test substitutes a double. That `WebSocket` begins connecting on construction, which is exactly the factory contract.
 *
 * It is the class from the copy of undici this package depends on rather than the one the host's own Node vendors, and the reason is the dispatcher: a dispatcher
 * object is not interchangeable across copies, so the class that accepts this package's `Agent` is the class from the same copy that `Agent` came from. The platform
 * global is a different class whose declaration carries no dispatcher option at all.
 *
 * @param url  - The connect URL.
 * @param init - The dial options this boundary passes to the constructor.
 *
 * @returns A live `WebSocket`, typed as the {@link WebSocketLike} interface.
 *
 * @category Log Client
 */
export const webSocketFactory: WebSocketFactory = (url: string, init: WebSocketDialInit): WebSocketLike => new WebSocket(url, init);

/**
 * The dial one connect attempt owns: the connector holding every socket that attempt's WebSocket is vended, and the dispatcher built over it.
 *
 * The two travel as one value because either without the other releases nothing - the dispatcher's destroy reaches the connection it is holding, the connector's
 * release reaches a socket still in its handshake, and only the pair covers an attempt whichever state its socket is in.
 *
 * @category Log Client
 */
export interface OwnedDial {

  readonly agent: Agent;
  readonly connector: OwnedConnector;
}

/**
 * The subset of the dial's own options this boundary states, leaving every other question to the factory.
 *
 * @category Log Client
 */
export interface OwnedDialInit {

  /** Which application protocols the dial offers. A WebSocket upgrade can use neither HTTP/2 nor pipelining, so the socket states `false` and both halves read it. */
  readonly allowH2: boolean;
}

/**
 * The factory that builds the {@link OwnedDial} one connect attempt owns.
 *
 * The production factory pairs an owned connector with a dispatcher that dials through it; a test substitutes a factory whose dial records what teardown ran on it,
 * which is the only way the order of those operations is observable at all - the connector never crosses any other boundary a caller can reach.
 *
 * @param init - The dial options this boundary states. See {@link OwnedDialInit}.
 *
 * @returns The dispatcher the WebSocket is dialed over, and the connector holding its sockets.
 *
 * @category Log Client
 */
export type OwnedDialFactory = (init: OwnedDialInit) => OwnedDial;

/**
 * The production {@link OwnedDialFactory}: an owned connector, and an `Agent` that dials through it.
 *
 * The connector is built with the protocol offer and nothing else, and the certificate-verification option is deliberately left unstated. This boundary carries no
 * such setting, so the dial leaves the question to the platform and whatever the process was started with still decides...which is what lets a user reaching a
 * Homebridge UI presenting its own certificate relax it the documented way.
 *
 * @param init - The dial options this boundary states. See {@link OwnedDialInit}.
 *
 * @returns The dispatcher the WebSocket is dialed over, and the connector holding its sockets.
 *
 * @category Log Client
 */
export const ownedDialFactory: OwnedDialFactory = ({ allowH2 }: OwnedDialInit): OwnedDial => {

  const connector = createOwnedConnector({ allowH2 });

  return { agent: new Agent({ allowH2, connect: connector.connect, pipelining: 0 }), connector };
};

/**
 * Construction-time options for {@link LogSocket}.
 *
 * @property backoff          - Optional override for the connect-phase backoff policy, invoked with the 1-indexed attempt about to run and returning the delay in
 *                              milliseconds. Defaults to the log client's own jittered exponential curve - a `RECONNECT_BASE_MS` base doubling each attempt and
 *                              capped at `RECONNECT_CAP_MS`, plus up to `JITTER_FRACTION` upward jitter. Overridden in tests with a near-zero delay so the
 *                              reconnect loop runs without real waits.
 * @property clock            - Optional time source for the session liveness window and the reconnect backoff waits. Passed through unresolved, so `systemClock` is
 *                              applied by the primitives that consume it. A test injects a `TestClock` to drive both without real waits.
 * @property host             - The hostname or IP of the homebridge-config-ui-x server.
 * @property log              - Logger for connection lifecycle and overflow diagnostics.
 * @property ownedDialFactory - The factory that builds the dial each connect attempt owns. Defaults to {@link ownedDialFactory}. A test substitutes a factory whose
 *                              dial records the teardown operations run on it, which is what makes their order assertable.
 * @property port             - The TCP port the server listens on. Defaults to `8581`.
 * @property random           - Injectable source of `[0, 1)` randomness for backoff jitter. Defaults to `Math.random`; held fixed in tests for deterministic backoff.
 * @property refreshable      - Whether the credential backing {@link LogSocketInit.tokenProvider} can mint a fresh token on a reconnect. `true` for `password`/`noauth`
 *                              credentials (each connect re-authenticates), `false` for a static `token`. When `false`, a handshake/namespace auth rejection is raised as
 *                              a permanent {@link LogAuthError} so the connect-phase retry veto makes it terminal rather than retrying a token that cannot be refreshed.
 * @property signal           - Optional parent {@link AbortSignal} composed with the socket's internal controller. When the parent aborts, the socket tears down.
 * @property stdoutHighWater  - Optional high-water mark for the bounded stdout queue, a positive integer. Defaults to `10000`. Overflow drops the oldest lines.
 * @property tls              - When `true`, use the secure (`wss`) scheme; when `false` or omitted, plaintext (`ws`).
 * @property tokenProvider    - Re-acquires a fresh token per connect attempt. See {@link TokenProvider}.
 * @property webSocketFactory - The factory that constructs the underlying WebSocket. Defaults to {@link webSocketFactory}.
 *
 * @category Log Client
 */
export interface LogSocketInit {

  readonly backoff?: (attempt: number) => number;
  readonly clock?: Clock;
  readonly host: string;
  readonly log: HomebridgePluginLogging;
  readonly ownedDialFactory?: OwnedDialFactory;
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
// after a shared outage. The `random` source is injected so the jittered delay is deterministic in tests; with `random` held fixed near zero the delay is effectively
// the base, which is how a bare unit test of this schedule drives it without real waits. The `LogSocket` reconnect tests instead override `backoff` directly to drive
// their loop without real waits.
function withJitter(base: number, random: () => number): number {

  return Math.round(base + (base * JITTER_FRACTION * random()));
}

// The log client's curve is the library's exponential ladder at the log client's own constants, built once at module scope so every reconnect wait consults one policy.
const reconnectLadder = exponentialBackoff({ ceilingMs: RECONNECT_CAP_MS, seedMs: RECONNECT_BASE_MS });

/**
 * The log client's connect-phase reconnect backoff policy: a dev-tuned jittered exponential curve with a low ceiling.
 *
 * This is the single source of truth for the socket's default reconnect timing. The base delay is `RECONNECT_BASE_MS` (500 ms) and it doubles with each successive
 * connect attempt, plateauing at the `RECONNECT_CAP_MS` ceiling (5 s) - deliberately snappier than `defaultRetryBackoff`'s 30-second ceiling, because a log-tailing
 * dev tool should resume the tail promptly after the frequent Homebridge restarts a plugin developer does rather than back off to a half-minute lag. Up to
 * `JITTER_FRACTION` of the computed base is added as upward jitter so a fleet of clients does not reconnect in lockstep after a shared outage.
 *
 * It is exported (rather than left inline in the constructor) so the bare schedule is a directly unit-testable function: with `random` held fixed at `0` the curve
 * yields the exact, deterministic 500, 1000, 2000, 4000, 5000, 5000, ... sequence. The curve itself is {@link exponentialBackoff}'s ladder built from
 * `RECONNECT_BASE_MS` and `RECONNECT_CAP_MS`, so the attempt numbering is the one that factory documents.
 *
 * @param attempt - The 1-indexed connect attempt about to run. Called only for the second and later attempts (the first runs with no wait).
 * @param random  - Source of `[0, 1)` randomness for the jitter. Defaults to `Math.random`; held fixed in tests for a deterministic schedule.
 *
 * @returns The delay, in milliseconds, to wait before running `attempt`.
 *
 * @category Log Client
 */
export function reconnectBackoff(attempt: number, random: () => number = Math.random): number {

  return withJitter(reconnectLadder(attempt), random);
}

// A single connected session: the live WebSocket, the dial that vended it, the per-session controller whose signal ends the streaming phase, the ping cadence the
// Engine.IO open handshake advertised (used to size the liveness watchdog), and a one-shot `closed` latch. A composed signal built fresh from the socket's lifetime
// signal and the controller's own signal governs both the connect-phase and streaming-phase teardown, so a socket-level abort ends the session too; a session-level
// abort (close, error, watchdog) ends only this session and lets the outer loop reconnect. The `closed` latch makes the WebSocket teardown safe to run twice: both
// the streaming phase's post-end cleanup and the socket-level teardown can race to close the same session, and the latch ensures the DISCONNECT-and-close sequence
// runs exactly once rather than twice.
interface Session {

  closed: boolean;
  readonly controller: AbortController;
  readonly owned: OwnedDial;
  readonly pingInterval: number;
  readonly pingTimeout: number;
  readonly ws: WebSocketLike;
}

// What one reported connect attempt answered with: the live session, or the failure that ended it together with the classifier's tag for it. A failure comes back as
// a value rather than as a throw because the repeat demotion is decided by what the attempt answered...`RepeatDemotedLog#attempt` weighs a returned classification,
// and a rejection it never gets to classify reports at full level every time.
type ConnectOutcome = { readonly error: unknown; readonly ok: false; readonly reason: TransportFailureKind } | { readonly ok: true; readonly session: Session };

/**
 * The consumer-facing surface of a live-log socket: the minimal interface a client reads off a {@link LogSocket}. This is the product half of the socket
 * dependency-inversion boundary, so a client depends on this narrow interface rather than the concrete {@link LogSocket} and a test can substitute a fake that yields
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
 * The creational half of the socket dependency-inversion boundary: build a {@link LogSocketLike} from the socket init. A client holds this factory typed as the
 * abstraction and constructs through it, so a test can substitute a factory that returns a fake socket. The production factory is {@link logSocketFactory}, whose
 * `create` is exactly the {@link LogSocket} constructor call, so routing construction through this factory is behavior-neutral - mirroring the `RecordingProcessFactory`
 * precedent.
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

  // The socket's time source, held UNRESOLVED so the `systemClock` default is applied by the watchdog and by `retry`, each in the one place that default belongs.
  // Both of this socket's timing concerns read this one field, so a session's liveness window and its reconnect backoff can never end up on different timelines.
  readonly #clock: Clock | undefined;

  readonly #host: string;
  readonly #log: HomebridgePluginLogging;

  // The scope every connect attempt is reported through. A dial that keeps failing the same way states itself once and then replays at debug for as long as the reason
  // holds, so a server that is down for an hour costs one line rather than one line per backoff interval. It is a field rather than a local because the memory it
  // carries is the whole reconnect episode: the attempt after this one is weighed against this one, and only a new socket - a new `tail()` call - starts over.
  readonly #failures: RepeatDemotedLog<TransportFailureKind>;

  // Whether any attempt in this socket's life has reported a failure. The recovery line reads it, so a connection that came up without anyone waiting on it stays
  // quiet rather than announcing a recovery from nothing.
  #reportedFailure = false;

  readonly #ownedDialFactory: OwnedDialFactory;
  readonly #port: number;
  readonly #random: () => number;
  readonly #refreshable: boolean;
  readonly #tls: boolean;
  readonly #tokenProvider: TokenProvider;
  readonly #webSocketFactory: WebSocketFactory;

  // The raw stdout lines staged for the `stdout()` consumer, in a queue built with the socket's high-water mark. What the queue does when it reaches that mark is
  // the queue's own contract; the socket owns the value and the one-time warning, and nothing else about it.
  readonly #stdoutQueue: AsyncQueue<string>;

  // A one-time flag so a chronically-slow consumer is warned exactly once rather than on every drop. The queue's own count of what it has discarded is what that
  // warning reports and what `droppedLines` reads.
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

    const stdoutHighWater = init.stdoutHighWater ?? DEFAULT_STDOUT_HIGH_WATER;

    // A mark that is not a positive integer describes no bound at all. The socket refuses it in its own words because stdoutHighWater is the option the caller
    // wrote; the queue guards its own option the same way for a caller that builds one directly, so each boundary names what it received.
    assertPositiveInteger(stdoutHighWater, { optionName: "stdoutHighWater", owner: "LogSocket" });

    this.#clock = init.clock;
    this.#host = init.host;
    this.#log = init.log;

    // Out of the alphabetical run deliberately: the adapter wraps the logger the line above assigns, so it is built after that assignment rather than where its own
    // name would sort.
    this.#failures = repeatDemotedLog<TransportFailureKind>(this.#log);

    this.#ownedDialFactory = init.ownedDialFactory ?? ownedDialFactory;
    this.#port = init.port ?? DEFAULT_PORT;
    this.#random = init.random ?? Math.random;
    this.#refreshable = init.refreshable;
    this.#stdoutQueue = new AsyncQueue({ highWaterMark: stdoutHighWater });
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
    // construction time (a pre-aborted parent), so the live connection is closed regardless of which path fired.
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
      await this.#loopTask.catch(() => {

        // Any rejection here is swallowed; there is nothing further for disposal to do with a cleanup-time failure.
      });
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

    return this.#stdoutQueue.dropped;
  }

  /**
   * The bounded push-to-pull stream of raw log lines (ANSI intact, terminators removed) the server streams over the log namespace's `stdout` events.
   *
   * The server delivers `stdout` as raw text chunks whose boundaries do not align with log lines; the socket runs each chunk through a per-session
   * {@link LogLineSplitter}, yields complete lines here, and flushes it on each session's close so the final line is never stranded. The lines are kept in an
   * {@link AsyncQueue} bounded by the high-water mark, which decouples the WebSocket producer from this consumer. The queue belongs to the socket rather than to any
   * one session, so it survives reconnects - the same iterable keeps yielding across a drop-and-reconnect - and a consumer iterates it once for the whole socket
   * lifetime. The stream terminates (returns) when the socket aborts; the queue is drained before it returns, so a line already staged before teardown is never lost.
   *
   * **Single-consumer only.** The queue parks one read at a time; iterating `stdout()` concurrently from two consumers is unsupported.
   *
   * @returns An async generator yielding raw log lines in stream order.
   */
  public stdout(): AsyncGenerator<string> {

    // The read is the queue's drain under the socket's signal: it hands over what is staged before it honors the abort, which is the no-staged-line-lost guarantee -
    // a line the splitter surfaced before teardown reaches the consumer even though the lifetime has already ended.
    return this.#stdoutQueue.drain(this.signal);
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
        session = await retry(async (attemptSignal): Promise<Session> => {

          const outcome = await this.#failures.attempt((attemptLog) => this.#attemptConnect(attemptSignal, attemptLog),
            (result): TransportFailureKind | undefined => result.ok ? undefined : result.reason);

          // The original error goes back to `retry` untouched, so `shouldRetry`'s veto, the backoff curve and the terminal report below all read the real error object
          // rather than anything the reporting wrapped it in.
          if(!outcome.ok) {

            throw outcome.error;
          }

          return outcome.session;
        }, {

          attempts: Infinity,
          backoff: this.#backoff,
          clock: this.#clock,
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

  // One reported connect attempt: runs the connect phase under the logger the adapter handed it, announces a recovery when this socket had reported a failure before,
  // and answers with a value on both paths. The failure comes back rather than propagating because the adapter decides the demotion from what the attempt ANSWERED,
  // and a rejection it never classifies would report at full level every time; `#runLoop` re-throws the original error immediately after, so nothing downstream sees a
  // difference.
  async #attemptConnect(attemptSignal: AbortSignal, attemptLog: HomebridgePluginLogging): Promise<ConnectOutcome> {

    try {

      const session = await this.#connect(attemptSignal);

      if(this.#reportedFailure) {

        this.#reportedFailure = false;
        attemptLog.info("Connected to the Homebridge log stream.");
      }

      return { ok: true, session };
    } catch(error: unknown) {

      const { kind } = classifyTransportError(error, attemptSignal);

      /* A teardown and a permanent authentication failure are both the loop's to report rather than this method's, so neither is stated twice. The signal `retry` hands
       * each attempt is the socket's own, so the classifier answers "aborted" for an attempt the consumer ended, and an orderly exit should say nothing at all.
       * `shouldRetry` vetoes the credential failure, so the loop stops and its terminal error line names it as the verdict it is. Everything else is a failure the loop
       * is about to retry, which is exactly the report a user waiting on a connection is owed.
       */
      if((kind !== "aborted") && !isPermanentAuthError(error)) {

        this.#reportedFailure = true;
        attemptLog.warn("Unable to connect to the Homebridge log stream: %s. Retrying.", formatErrorMessage(error));
      }

      return { error, ok: false, reason: kind };
    }
  }

  // Connect phase. Re-acquires a fresh token, builds the dial this attempt owns, opens the WebSocket over that dial's dispatcher, awaits the Engine.IO open handshake
  // (capturing its ping cadence), joins the `/log` namespace, and emits `tail-log`. Resolves with the live session once `tail-log` has been emitted; rejects on any
  // handshake fault (WebSocket error, CONNECT_ERROR, peer close, or attempt abort), so `retry` governs the backoff. A per-attempt controller composed under the
  // attempt signal ensures a failed attempt's WebSocket, dial and listeners are torn down before the next attempt opens a new one; on success that same controller
  // becomes the session controller, so the streaming phase shares the teardown path.
  async #connect(attemptSignal: AbortSignal): Promise<Session> {

    const token = await this.#tokenProvider(attemptSignal);
    const url = socketUrl({ host: this.#host, port: this.#port, tls: this.#tls, token });

    const controller = new AbortController();
    const composed = composeSignals(attemptSignal, controller.signal);

    /* A WebSocket upgrade can use neither HTTP/2 nor pipelining, which is the socket's own reading of its protocol rather than the dial's, so it is stated here and
     * handed down. Both halves of the dial act on that one fact - the connector's copy decides which protocols the dial offers, the dispatcher's decides what it does
     * with the connection afterward - and a single binding carried through the factory is what keeps the two from disagreeing.
     *
     * The dial belongs to the attempt rather than to the socket, because this loop calls this method an unbounded number of times over one socket's life. A connector
     * held for the whole of that would accumulate established-socket references across hours of reconnects and would report a dial failure belonging to some older
     * attempt, so it is built here and released with the socket it vended - the same per-attempt shape the controller above already has.
     */
    const allowH2 = false;
    const owned = this.#ownedDialFactory({ allowH2 });
    const ws = this.#webSocketFactory(url, { dispatcher: owned.agent });

    // Capture the Engine.IO open handshake's ping cadence so the streaming phase can size the liveness watchdog from the server's real cadence rather than a guess.
    let pingInterval = 0;
    let pingTimeout = 0;

    // The connect handshake is a one-shot promise resolved by the message handler once `tail-log` has been emitted, or rejected by an error / close / CONNECT_ERROR /
    // abort.
    const { promise: connected, resolve, reject }: PromiseWithResolvers<void> = Promise.withResolvers();

    // Tear down this attempt's WebSocket and dial when the composed signal aborts (attempt abort or our own controller abort), and reject the connect promise so a
    // pending handshake unwinds. The `using` disposer removes the listener when this method's scope exits.
    using abortRegistration = onAbort(composed, () => {

      reject(composed.reason);
      this.#closeWebSocket(ws, owned);
    });

    ws.addEventListener("error", (event: unknown) => {

      reject(new HbpuAbortError("failed", { cause: this.#describeWsError(event, owned.connector) }));
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

      this.#closeWebSocket(ws, owned);

      throw error;
    }

    return { closed: false, controller, owned, pingInterval, pingTimeout, ws };
  }

  // Streaming phase. The session is connected; split `stdout` chunks into lines and route them into the bounded queue, answer pings with pongs and re-arm the liveness
  // watchdog, and end the session on close / error / watchdog timeout, logging its cause at debug. Resolves when the session's signal aborts - which the outer loop
  // reads to decide whether to reconnect. The watchdog window is sized from the server's advertised ping cadence plus a margin and is armed on the socket's clock, so
  // a test drives the window by advancing that clock.
  async #stream(session: Session): Promise<void> {

    this.#session = session;

    const composed = composeSignals(this.signal, session.controller.signal);

    // The per-session line splitter. The server delivers `stdout` events as raw text chunks whose boundaries do not align with log lines; the splitter reassembles lines
    // across chunk boundaries and normalizes the mixed newline conventions. It is per-session (a fresh connection starts with a clean carry) and is flushed on session
    // close so the final line - which the splitter withholds when a chunk ends on a lone line-feed pending a possible cross-chunk pair - surfaces rather than stranding.
    const splitter = new LogLineSplitter();

    // The liveness watchdog, sized from the server's advertised ping cadence captured during the connect handshake: one ping interval plus the ping timeout plus a fixed
    // margin, so a single late ping does not trip it. A zero/absent cadence (malformed handshake) falls back to the margin alone. Each inbound ping re-arms it; if the
    // window lapses with no ping, it aborts the SESSION (not the whole socket), so the outer loop reconnects. It is armed on the socket's clock, the same one the
    // reconnect backoff waits on, so a test that injects a `TestClock` drives the liveness window and the reconnect curve together.
    const windowMs = ((session.pingInterval > 0) ? session.pingInterval : 0) + ((session.pingTimeout > 0) ? session.pingTimeout : 0) + MARGIN_MS;
    const watchdog = new Watchdog({ clock: this.#clock, onFire: (): void => session.controller.abort(new HbpuAbortError("timeout")), signal: composed,
      timeoutMs: windowMs });

    // A single resolver settled when the session ends so this method awaits the session lifetime without a busy loop. `onAbort` settles it on session abort; the message
    // and close handlers drive the session controller, which aborts the composed signal, which fires this.
    const { promise: ended, resolve: endSession }: PromiseWithResolvers<void> = Promise.withResolvers();

    using ownedWatchdog = watchdog;
    using abortRegistration = onAbort(composed, () => endSession());

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

        session.controller.abort(new HbpuAbortError("failed", { cause: this.#describeWsError(event, session.owned.connector) }));
      }
    });

    await ended;

    // A session's end is the loop's to recover from rather than a failure to report, so its cause goes to a debug line, where a reset names its errno through the
    // connection record the error listener read.
    this.#log.debug("The Homebridge log stream session ended: %s.", formatErrorMessage(composed.reason));

    // Flush the splitter on session end so the final line - withheld by the splitter when the last chunk ended on a lone line-feed pending a possible cross-chunk pair -
    // surfaces rather than stranding. This is the flush the wiring note calls for; mid-stream the next chunk drains the carry, but at session close no next
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

  // Hand a complete log line to the `stdout()` consumer. The queue enforces the bound: at the high-water mark the OLDEST line goes, because a live tail cares about
  // recent output rather than stale backlog. The one-time warning fires on the first push that finds the queue reporting a drop, so a chronically-slow consumer
  // learns it is lossy without the log being flooded.
  #enqueueStdout(line: string): void {

    this.#stdoutQueue.push(line);

    if((this.#stdoutQueue.dropped > 0) && !this.#overflowLogged) {

      this.#overflowLogged = true;
      this.#log.warn("The Homebridge log stream is producing output faster than it is being consumed; the oldest buffered lines are being dropped.");
    }
  }

  /* Render a WebSocket `"error"` event for diagnostics, from the records of the connector that vended the socket ahead of the event itself, because undici reports a
   * content-free error on this event - present, and rendering as the empty string - for a dial that failed and for an established connection the peer reset alike.
   * The attempt's dial failure is read first and it wins outright, since a dial that failed established nothing: the order here is the difference between a reader
   * seeing `ECONNREFUSED` and a reader seeing nothing at all. The connection record comes next, the first error the established socket raised itself, which names a
   * reset the event cannot, and it reads empty for a peer that hung up without one, so that hang-up falls through to the event.
   *
   * Below those, the error event's own field when it carries one, and a generic label when it does not, so the abort cause is at least minimally informative. Each
   * phase hands in its connector, because each can meet a failed connection: the connect phase between the upgrade and the namespace join, and a streaming session
   * at any point once its dial is over, which leaves its dial record empty.
   */
  #describeWsError(event: unknown, connector: Pick<OwnedConnector, "lastConnectionFailure" | "lastDialFailure">): unknown {

    const recorded = connector.lastDialFailure ?? connector.lastConnectionFailure;

    if(recorded !== undefined) {

      return recorded;
    }

    if((typeof event === "object") && (event !== null) && ("error" in event)) {

      return event.error;
    }

    return new Error("WebSocket connection error.");
  }

  // Close a session's WebSocket cleanly: send the namespace DISCONNECT (`41/log,`) only when the connection is still OPEN, then ALWAYS issue `close(1000)`. Repeatable
  // via the session's one-shot `closed` latch - both the streaming phase's post-end cleanup and the socket-level teardown can reach the same live session, and the latch
  // ensures the DISCONNECT-and-close sequence runs exactly once. The readyState gate avoids a send on a half-closed connection; the unconditional close is the teardown
  // guarantee.
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

    this.#closeWebSocket(session.ws, session.owned);
  }

  /* End one attempt's WebSocket and the dial that vended it: let the dispatcher go first, issue the orderly `close(1000)` so the peer sees a clean disconnect,
   * swallow any throw from a socket that is already past closing, then release the connector's own sockets. Every step is safe to reach again, which matters because
   * more than one path converges here on the same attempt.
   *
   * The dispatcher goes first, and that is the one thing a reader cannot recover from the code. Closing a socket that is still in its handshake aborts the request
   * underneath it in a way the transport treats as retryable, so it dials a second socket through this same connector that nothing will ever release. Destroying the
   * dispatcher fails that request outright and takes its socket with it, so there is nothing left to retry. An upgrade that completed is unaffected either way:
   * the transport has already detached that socket, so the close frame is written straight to it and the release is what severs it afterward, rather than waiting on
   * a peer that is under no obligation to answer.
   *
   * What actually forecloses the re-dial is that the destroy is ADJACENT to the close, in the same synchronous stack. The aborted request's socket raises its `close`
   * event a tick or more later, and the transport consults its own destroyed flag at that moment: a destroy anywhere in this tick has already set that flag, while a
   * destroy deferred past it lets the re-dial reach the network. Ordering the destroy first is the simplest sufficient way to hold that adjacency, and it is what
   * keeps a later edit from opening a gap between the two calls rather than a property of "first" on its own.
   *
   * The destroy settles later and nothing here waits on it - what matters is that it is CALLED in this stack, because the flag it sets is synchronous. It is
   * discarded through `markHandled` rather than a bare `void` so a rejection is observed rather than floating.
   *
   * Neither the destroy nor the release carries a guard of its own, and that is from the source rather than from optimism: `release()` calls nothing but `destroy()`
   * on sockets, which marks and schedules rather than throwing, and a dispatcher's destroy resolves even when it has already been destroyed. The `try` stays around
   * the close alone, where a throw genuinely can come from.
   */
  #closeWebSocket(ws: WebSocketLike, owned: OwnedDial): void {

    void markHandled(owned.agent.destroy());

    try {

      ws.close(1000);
    } catch {

      // Closing a socket that is already closed (or in a state where close throws) is a no-op for our purposes.
    }

    owned.connector.release();
  }

  // Single teardown convergence point, fired exactly once when `this.signal` aborts. Closes the live session's WebSocket (sending the namespace DISCONNECT if OPEN, then
  // always close(1000)); the stdout drain observes the signal itself, so there is nothing here to wake it with. The reconnect loop observes the aborted signal and
  // exits on its next iteration boundary; the watchdog self-cleans through its own composed-signal listener.
  #teardown(): void {

    if(this.#session !== undefined) {

      this.#closeSession(this.#session);
      this.#session = undefined;
    }
  }
}

/**
 * The production {@link LogSocketFactory}: builds the concrete WebSocket-backed {@link LogSocket}. A client holds the factory typed as the {@link LogSocketFactory}
 * abstraction; a test substitutes a fake factory. `create` is exactly the {@link LogSocket} constructor call, so wiring construction through this factory is
 * behavior-neutral.
 *
 * @category Log Client
 */
export const logSocketFactory: LogSocketFactory = {

  create: (init: LogSocketInit): LogSocketLike => new LogSocket(init)
};
