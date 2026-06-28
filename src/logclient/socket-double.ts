/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * logclient/socket-double.ts: Reusable test doubles for the WebSocket and LogSocket dependency-inversion seams.
 */

/**
 * Reusable test doubles for the log client's two socket seams.
 *
 * Two seams drive the live-log transport: the low-level {@link WebSocketFactory} ({@link logclient/socket!LogSocket | LogSocket} builds a {@link WebSocketLike} from
 * it) and the high-level {@link LogSocketFactory} (a client builds a {@link LogSocketLike} from it). This module ships the fakes that cash both in, mirroring the
 * shape of `recording-process-double.ts`:
 *
 * - {@link TestWebSocket} - a controllable {@link WebSocketLike} that captures every frame sent and every close code, and exposes `emitOpen` / `emitMessage` /
 *   `emitError` / `emitClose` so a test drives the socket state machine frame by frame without a real network. {@link TestWebSocketFactory} records every `create` call
 *   (the connect URL) and returns the socket.
 * - {@link TestLogSocket} - a {@link LogSocketLike} that yields caller-supplied lines from `stdout()` and aborts a genuine {@link AbortSignal} on `abort()`.
 *   {@link TestLogSocketFactory} records every `create` call (the init it was passed) and returns the socket, so a client can be exercised without a WebSocket at all.
 *
 * @module
 */
import { HbpuAbortError, onAbort } from "../util.ts";
import type { LogSocketFactory, LogSocketInit, LogSocketLike, WebSocketFactory, WebSocketLike } from "./socket.ts";
import { WEBSOCKET_OPEN } from "./socket.ts";

// The DOM `WebSocket.CLOSED` readyState value. Named locally so the double can report a post-close readyState without depending on the platform constant, matching the
// way `socket.ts` names {@link WEBSOCKET_OPEN}.
const WEBSOCKET_CLOSED = 3;

/**
 * A controllable {@link WebSocketLike} test double. It captures every frame the socket under test sends and every close code it issues, and it exposes explicit emit
 * methods so a test can drive the connection through its handshake, ping/pong, streaming, and teardown by hand - no real network, fully deterministic.
 *
 * Fidelity to the seam contract: `readyState` starts OPEN and flips to CLOSED on the first `close()` (or an inbound {@link TestWebSocket.emitClose}), so the socket's
 * teardown gate (send the namespace DISCONNECT only while OPEN) behaves exactly as it would against a real connection; `send` records the frame regardless of state so a
 * test can assert the exact wire sequence including any post-close send attempt.
 *
 * @category Testing
 */
export class TestWebSocket implements WebSocketLike {

  // Every frame passed to `send`, in order, so a test can assert the exact wire sequence the socket produced (the namespace connect, the `tail-log` event, each pong, the
  // namespace DISCONNECT).
  public readonly sent: string[] = [];

  // Every close code passed to `close`, in order. A test asserts `close(1000)` is always issued on teardown.
  public readonly closeCodes: number[] = [];

  // The connect URL this socket was constructed with, retained for assertions on the query string (EIO version, transport, token).
  public readonly url: string;

  // The registered listeners, keyed by event type. Each emit method dispatches to every listener registered for its type, mirroring the DOM `addEventListener` fan-out.
  readonly #closeListeners: ((event: { readonly code: number }) => void)[] = [];
  readonly #errorListeners: ((event: unknown) => void)[] = [];
  readonly #messageListeners: ((event: { readonly data: unknown }) => void)[] = [];
  readonly #openListeners: (() => void)[] = [];

  // The current readyState. Starts OPEN (the double models a connection that is already established by the time a test drives it) and flips to CLOSED on the first close.
  #readyState: number = WEBSOCKET_OPEN;

  /**
   * Construct a controllable WebSocket double.
   *
   * @param url - The connect URL the factory was asked to build. Defaults to an empty string for tests that do not assert on the URL.
   */
  public constructor(url = "") {

    this.url = url;
  }

  /**
   * Register a listener. Mirrors the DOM `addEventListener` overloads the {@link WebSocketLike} seam declares; the matching `emit*` method dispatches to every
   * registered listener of that type.
   *
   * @param type     - The event type to listen for.
   * @param listener - The listener to register.
   */
  public addEventListener(type: "close", listener: (event: { readonly code: number }) => void): void;
  public addEventListener(type: "error", listener: (event: unknown) => void): void;
  public addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
  public addEventListener(type: "open", listener: () => void): void;
  public addEventListener(type: "close" | "error" | "message" | "open", listener: unknown): void {

    switch(type) {

      case "close": {

        this.#closeListeners.push(listener as (event: { readonly code: number }) => void);

        return;
      }

      case "error": {

        this.#errorListeners.push(listener as (event: unknown) => void);

        return;
      }

      case "message": {

        this.#messageListeners.push(listener as (event: { readonly data: unknown }) => void);

        return;
      }

      case "open": {

        this.#openListeners.push(listener as () => void);

        return;
      }

      default: {

        return;
      }
    }
  }

  /**
   * Close the socket. Records the close code and flips `readyState` to CLOSED. Idempotent in the sense the seam needs: a second close simply records a second code.
   *
   * @param code - The close code. Defaults to 1000 (normal closure), matching the platform default.
   */
  public close(code = 1000): void {

    this.closeCodes.push(code);
    this.#readyState = WEBSOCKET_CLOSED;
  }

  /**
   * The current readyState: {@link WEBSOCKET_OPEN} until the first close, `WEBSOCKET_CLOSED` after.
   */
  public get readyState(): number {

    return this.#readyState;
  }

  /**
   * Record an outbound frame. The frame is captured regardless of `readyState` so a test can assert the full wire sequence, including any send attempted after close.
   *
   * @param data - The frame text.
   */
  public send(data: string): void {

    this.sent.push(data);
  }

  /**
   * Dispatch a `close` event to every registered close listener and flip `readyState` to CLOSED, simulating the peer closing the connection.
   *
   * @param code - The close code to deliver. Defaults to 1000.
   */
  public emitClose(code = 1000): void {

    this.#readyState = WEBSOCKET_CLOSED;

    for(const listener of [...this.#closeListeners]) {

      listener({ code });
    }
  }

  /**
   * Dispatch an `error` event to every registered error listener, simulating a transport-level error.
   *
   * @param event - The error event payload. Defaults to an object carrying an `error` field, the shape the socket's error describer reads.
   */
  public emitError(event: unknown = { error: new Error("Test WebSocket error.") }): void {

    for(const listener of [...this.#errorListeners]) {

      listener(event);
    }
  }

  /**
   * Dispatch a `message` event carrying `data` to every registered message listener, simulating an inbound frame.
   *
   * @param data - The frame text (or any value, to exercise the socket's non-string guard).
   */
  public emitMessage(data: unknown): void {

    for(const listener of [...this.#messageListeners]) {

      listener({ data });
    }
  }

  /**
   * Dispatch an `open` event to every registered open listener, simulating the transport-layer connection opening.
   */
  public emitOpen(): void {

    for(const listener of [...this.#openListeners]) {

      listener();
    }
  }
}

/**
 * A {@link WebSocketFactory} double that records every `create` call (the connect URL) and returns a {@link TestWebSocket}. By default it returns a fresh socket per
 * call, which is exactly what the reconnect path needs - each connect attempt gets a distinct controllable socket - and the recorded sockets are retained in order so a
 * test can drive the second attempt's socket after failing the first.
 *
 * @category Testing
 */
export class TestWebSocketFactory {

  // Every socket handed out, in creation order, so a test can drive a specific connect attempt's socket (e.g., fail attempt 0's socket, then drive attempt 1's).
  public readonly sockets: TestWebSocket[] = [];

  // The URLs every `create` was called with, in order, for assertions on the connect URL across reconnects.
  public readonly urls: string[] = [];

  // An optional fixed socket to return from every `create`; when omitted, each `create` mints a fresh one.
  readonly #socket: TestWebSocket | undefined;

  // Pending `socketCreated(index)` waiters, keyed by the 0-based creation-order index they await. Resolved synchronously inside `create` the moment that index is
  // minted, so a reconnect test can await the ACTUAL construction of the next attempt's socket rather than racing a fixed wall-clock delay against the loop's backoff.
  readonly #createWaiters = new Map<number, PromiseWithResolvers<TestWebSocket>>();

  /**
   * Construct a WebSocket-factory double.
   *
   * @param socket - Optional fixed {@link TestWebSocket} to return from every `create`. When omitted, each `create` returns a fresh socket built with the call's URL.
   */
  public constructor(socket?: TestWebSocket) {

    this.#socket = socket;
  }

  /**
   * The {@link WebSocketFactory} function this double exposes. Bound as an arrow property so it can be passed directly as the `webSocketFactory` seam without losing
   * `this`.
   *
   * @param url - The connect URL.
   *
   * @returns The recorded {@link TestWebSocket}.
   */
  public readonly create: WebSocketFactory = (url: string): WebSocketLike => {

    const socket = this.#socket ?? new TestWebSocket(url);

    this.urls.push(url);
    this.sockets.push(socket);

    // Settle any waiter parked on the index just filled (the new length minus one), so a pending `socketCreated()` resolves the moment its socket is constructed.
    const waiter = this.#createWaiters.get(this.sockets.length - 1);

    if(waiter) {

      this.#createWaiters.delete(this.sockets.length - 1);
      waiter.resolve(socket);
    }

    return socket;
  };

  /**
   * Resolve when the socket at `index` (0-based, in creation order) has been constructed, returning it - immediately when it already exists. Lets a reconnect test
   * await the next connect attempt's socket deterministically instead of racing the reconnect loop's backoff against a fixed wall-clock delay.
   *
   * @param index - The 0-based creation-order index to await.
   * @returns A promise resolving to the {@link TestWebSocket} at that index.
   */
  public socketCreated(index: number): Promise<TestWebSocket> {

    const existing = this.sockets[index];

    if(existing) {

      return Promise.resolve(existing);
    }

    const waiter = this.#createWaiters.get(index) ?? Promise.withResolvers<TestWebSocket>();

    this.#createWaiters.set(index, waiter);

    return waiter.promise;
  }
}

/**
 * Construction-time configuration for a {@link TestLogSocket}. Every field defaults, so a bare `new TestLogSocket()` is usable.
 *
 * @property droppedLines - The value the `droppedLines` getter reports. Defaults to `0`.
 * @property lines        - The raw log lines `stdout()` yields, in order, before it parks awaiting abort. Defaults to an empty array.
 *
 * @category Testing
 */
export interface TestLogSocketInit {

  droppedLines?: number;
  lines?: readonly string[];
}

/**
 * A {@link LogSocketLike} test double. It yields caller-supplied lines from `stdout()` and then parks until aborted, mirroring how the real socket keeps a live stream
 * open after the seed; `abort()` aborts a genuine {@link AbortSignal} with a real {@link HbpuAbortError} reason so a consumer's abort-reason derivations stay meaningful.
 * A consumer can drive a client end to end against this double without a WebSocket.
 *
 * @category Testing
 */
export class TestLogSocket implements LogSocketLike {

  // The reasons every `abort(reason?)` call was invoked with, in order, for assertions. A no-argument call records the defaulted `HbpuAbortError("shutdown")`.
  public readonly abortCalls: unknown[] = [];

  // The internal controller whose signal is exposed as the socket lifetime. Owned privately so the only abort verb is `abort()`, which records the call.
  readonly #controller = new AbortController();

  readonly #droppedLines: number;
  readonly #lines: readonly string[];

  /**
   * Construct a log-socket double.
   *
   * @param init - Optional configuration. See {@link TestLogSocketInit}. Every field defaults, so a bare `new TestLogSocket()` is valid.
   */
  public constructor(init: TestLogSocketInit = {}) {

    this.#droppedLines = init.droppedLines ?? 0;
    this.#lines = init.lines ?? [];
  }

  /**
   * Abort the socket. Aborts the internal signal with the supplied reason, defaulting to a real `HbpuAbortError("shutdown")`, and records the (defaulted) reason. Safe to
   * call more than once: the underlying signal aborts only once.
   *
   * @param reason - Optional abort reason. Typically an {@link HbpuAbortError}.
   */
  public abort(reason?: unknown): void {

    const resolvedReason = reason ?? new HbpuAbortError("shutdown");

    this.abortCalls.push(resolvedReason);
    this.#controller.abort(resolvedReason);
  }

  /**
   * `AsyncDisposable` implementation. Aborts the socket (defaulting to `"shutdown"`).
   *
   * @returns A resolved promise once the abort has been issued.
   */
  public async [Symbol.asyncDispose](): Promise<void> {

    this.abort();
  }

  /**
   * `true` once the socket's signal has aborted.
   */
  public get aborted(): boolean {

    return this.#controller.signal.aborted;
  }

  /**
   * The configured dropped-line count.
   */
  public get droppedLines(): number {

    return this.#droppedLines;
  }

  /**
   * The composed abort signal representing this socket's lifetime. Aborts exactly once, when `abort()` is called.
   */
  public get signal(): AbortSignal {

    return this.#controller.signal;
  }

  /**
   * Yield the configured lines in order, then park until the socket aborts (mirroring a live stream that stays open after its seed). Terminates (returns) when the
   * signal aborts, so a consumer iterating this generator unwinds cleanly on `abort()` or disposal.
   *
   * @returns An async generator yielding the configured raw log lines, then parking until abort.
   */
  public async *stdout(): AsyncGenerator<string> {

    for(const line of this.#lines) {

      if(this.#controller.signal.aborted) {

        return;
      }

      yield line;
    }

    // Park until aborted. A single resolver settled by `onAbort` lets the generator suspend without a busy loop; the pre-aborted path runs the handler inline so an
    // already-aborted socket returns immediately rather than hanging.
    if(this.#controller.signal.aborted) {

      return;
    }

    const { promise, resolve }: PromiseWithResolvers<void> = Promise.withResolvers();

    using _registration = onAbort(this.#controller.signal, () => resolve());

    await promise;
  }
}

/**
 * A {@link LogSocketFactory} double that records every `create` call (the init it was passed) and returns a {@link TestLogSocket}, mirroring the create-call-recording
 * discipline `TestRecordingProcessFactory` uses. By default it returns a fresh, default-configured socket per call; supply a socket to the constructor to return a single
 * pre-configured instance from every `create`.
 *
 * @category Testing
 */
export class TestLogSocketFactory implements LogSocketFactory {

  // Every create call's init and the socket returned, in order, so a test can assert the seam was exercised with the expected init and can drive the returned socket.
  public readonly createCalls: { init: LogSocketInit; socket: TestLogSocket }[] = [];

  // The pre-configured socket to return from every create, when supplied; otherwise each create returns a fresh default-configured socket.
  readonly #socket: TestLogSocket | undefined;

  /**
   * Construct a log-socket-factory double.
   *
   * @param socket - Optional pre-configured {@link TestLogSocket} to return from every `create`. When omitted, each `create` returns a fresh, default-configured socket.
   */
  public constructor(socket?: TestLogSocket) {

    this.#socket = socket;
  }

  /**
   * Record the create call and return a {@link TestLogSocket} - the constructor-supplied instance when one was given, otherwise a fresh default-configured one.
   *
   * @param init - The {@link LogSocketInit} the consumer passed.
   *
   * @returns The log-socket double.
   */
  public create(init: LogSocketInit): LogSocketLike {

    const socket = this.#socket ?? new TestLogSocket();

    this.createCalls.push({ init, socket });

    return socket;
  }
}
