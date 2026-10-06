/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * api-dispatcher.test.ts: Unit tests for the API dispatcher factory - the pool and retry derivations with every default and override, the header stamp across every
 * shape a dispatch may carry its headers in, and the composed dispatcher exercised end to end against ephemeral servers, its answer to a request's own signal among
 * them.
 *
 * The derivations are asserted against written-out literals rather than against the module's own exported constants, because a comparison drawn from the same
 * declaration under test agrees with a typo in it. The wire phases exist for what no pure assertion can reach: whether the caller's retry policy actually arrives at
 * the interceptor, whether opting out really composes nothing, and how many times a request touched the network. Each phase owns its own server and its own counter,
 * so no phase can borrow another's evidence.
 *
 * The cancellation phases cover what a request's own signal does while its response has not started, read from what the transport itself reports: the dials a pool
 * makes, counted on the transport's connect channel for the phase's own origin, the listeners a signal still carries once its request is over, and, through a raw
 * dispatch handler, every callback a caller is handed, because the request API swallows a second terminal callback and only a raw handler can show that a request
 * ended exactly once. A phase asserting what a request the abort leaves alone does writes the transport's own answer out as a literal.
 */
import { API_RETRY_STATUS_CODES, apiPoolOptions, apiRetryOptions, createApiDispatcher, headerStampInterceptor } from "./api-dispatcher.ts";
import { EventEmitter, getEventListeners } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable, Writable } from "node:stream";
import { assertNoUnhandledRejections, expectAt, freePort, listenOnLoopback, settle, stopListening, waitUntil } from "./testing/index.ts";
import { describe, test } from "node:test";
import { errors, request, stream, upgrade } from "undici";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import type { ApiDispatcherOptions } from "./api-dispatcher.ts";
import type { Dispatcher } from "undici";
import type { Duplex } from "node:stream";
import { HbpuAbortError } from "./util.ts";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { systemClock } from "./clock.ts";

// The user-agent every wire phase supplies and then looks for on the far end.
const USER_AGENT = "test-plugin/9.9.9";

// The retry configuration this module defaults to, written out rather than derived, so a typo in the module's own constants fails these assertions.
const FAMILY_RETRY = { maxRetries: 3, maxTimeout: 5000, minTimeout: 1000, statusCodes: [ 400, 404, 429, 500, 502, 503, 504 ], timeoutFactor: 2 };

// The smallest set of options the factory accepts, which every derivation case builds on.
const BASE_OPTIONS = { origin: "https://api.example.com", userAgent: USER_AGENT };

// An ephemeral server that answers from a script, counts what it served, and remembers the user-agent it was asked with each time.
interface TestServer {

  agents: string[];
  close: () => Promise<void>;
  firstHit: Promise<void>;
  hits: () => number;
  origin: string;
}

/* Start a loopback server on a kernel-assigned port. Each request is answered with the next status in `script`, and the last entry stands for every request past the
 * script's length, so a phase only has to write down the answers it cares about.
 */
async function startServer(script: readonly number[]): Promise<TestServer> {

  const agents: string[] = [];
  const firstHit: PromiseWithResolvers<void> = Promise.withResolvers();

  const server = createServer((incoming, response) => {

    agents.push(incoming.headers["user-agent"] ?? "");

    const status = script[Math.min(agents.length - 1, script.length - 1)] ?? 200;

    response.writeHead(status, { "content-type": "text/plain" });
    response.end("ok");

    firstHit.resolve();
  });

  const port = await listenOnLoopback(server);

  return {

    agents,
    close: async (): Promise<void> => stopListening(server),
    firstHit: firstHit.promise,
    hits: (): number => agents.length,
    origin: "http://127.0.0.1:" + port.toString()
  };
}

describe("the API pool derivation", () => {

  test("applies every default, the connect timeout among them", () => {

    assert.deepEqual(apiPoolOptions(BASE_OPTIONS), { allowH2: true, clientTtl: 60000, connect: { timeout: 5000 }, connections: 1 });
  });

  test("carries a spelled-out certificate setting either way, and leaves the platform's own default in place when nothing is said", () => {

    assert.deepEqual(apiPoolOptions(BASE_OPTIONS), { allowH2: true, clientTtl: 60000, connect: { timeout: 5000 }, connections: 1 });

    assert.deepEqual(apiPoolOptions({ ...BASE_OPTIONS, rejectUnauthorized: false }),
      { allowH2: true, clientTtl: 60000, connect: { rejectUnauthorized: false, timeout: 5000 }, connections: 1 });

    assert.deepEqual(apiPoolOptions({ ...BASE_OPTIONS, rejectUnauthorized: true }),
      { allowH2: true, clientTtl: 60000, connect: { rejectUnauthorized: true, timeout: 5000 }, connections: 1 });
  });

  test("carries each construction option through verbatim", () => {

    assert.deepEqual(apiPoolOptions({ ...BASE_OPTIONS, allowH2: false }), { allowH2: false, clientTtl: 60000, connect: { timeout: 5000 }, connections: 1 });
    assert.deepEqual(apiPoolOptions({ ...BASE_OPTIONS, clientTtl: 120000 }), { allowH2: true, clientTtl: 120000, connect: { timeout: 5000 }, connections: 1 });
    assert.deepEqual(apiPoolOptions({ ...BASE_OPTIONS, connections: 2 }), { allowH2: true, clientTtl: 60000, connect: { timeout: 5000 }, connections: 2 });
  });

  test("carries a supplied connect timeout through, alone and beside the relaxed certificate check", () => {

    assert.deepEqual(apiPoolOptions({ ...BASE_OPTIONS, connectTimeout: 3500 }), { allowH2: true, clientTtl: 60000, connect: { timeout: 3500 }, connections: 1 });

    assert.deepEqual(apiPoolOptions({ ...BASE_OPTIONS, connectTimeout: 3500, rejectUnauthorized: false }),
      { allowH2: true, clientTtl: 60000, connect: { rejectUnauthorized: false, timeout: 3500 }, connections: 1 });
  });

  test("keeps a null clientTtl, which asks for no recycling at all", () => {

    assert.deepEqual(apiPoolOptions({ ...BASE_OPTIONS, clientTtl: null }), { allowH2: true, clientTtl: null, connect: { timeout: 5000 }, connections: 1 });
  });
});

describe("the API retry derivation", () => {

  test("defaults to the vetted policy", () => {

    assert.deepEqual(apiRetryOptions(undefined), FAMILY_RETRY);
  });

  test("keeps the vetted status list when only another field is overridden", () => {

    assert.deepEqual(apiRetryOptions({ maxRetries: 5 }), { ...FAMILY_RETRY, maxRetries: 5 });
  });

  test("keeps the vetted status list when a field is supplied as undefined", () => {

    assert.deepEqual(apiRetryOptions({ maxRetries: 5, statusCodes: undefined }), { ...FAMILY_RETRY, maxRetries: 5 });
  });

  test("hands every derivation its own status list", () => {

    const first = apiRetryOptions(undefined);
    const second = apiRetryOptions(undefined);

    assert.notStrictEqual(first?.statusCodes, second?.statusCodes);

    first?.statusCodes?.push(999);

    assert.deepEqual(second?.statusCodes, FAMILY_RETRY.statusCodes);
  });

  test("exports the same status list it derives", () => {

    assert.deepEqual([...API_RETRY_STATUS_CODES], FAMILY_RETRY.statusCodes);
  });

  test("derives nothing at all when retries are declined", () => {

    assert.equal(apiRetryOptions(false), undefined);
  });
});

// One header-stamp case: the header set a request arrives with, and the set the wrapped dispatch must be handed.
interface HeaderCase {

  expected: Dispatcher.DispatchOptions["headers"];
  headers: Dispatcher.DispatchOptions["headers"];
  name: string;
}

// A deliberately mixed-case name, so every case also proves the case-insensitive match, and a header nobody's policy cares about, so these test the mechanism rather
// than the user-agent the factory happens to compose it with.
const STAMP_NAME = "X-Correlation-Id";
const STAMP_VALUE = "abc-123";

const HEADER_CASES: readonly HeaderCase[] = [

  { expected: { [STAMP_NAME]: STAMP_VALUE }, headers: undefined, name: "no headers at all" },
  { expected: { [STAMP_NAME]: STAMP_VALUE }, headers: null, name: "a null header set" },

  { expected: { [STAMP_NAME]: STAMP_VALUE, accept: "application/json" }, headers: { accept: "application/json" },
    name: "a record without the header" },

  { expected: { [STAMP_NAME]: STAMP_VALUE, accept: "application/json" }, headers: { accept: "application/json", "x-correlation-ID": "stale" },
    name: "a record carrying the header in another case" },

  { expected: [ "accept", "application/json", STAMP_NAME, STAMP_VALUE ], headers: [ "accept", "application/json" ],
    name: "a flat list without the header" },

  { expected: [ "accept", "application/json", "X-CORRELATION-ID", STAMP_VALUE ], headers: [ "accept", "application/json", "X-CORRELATION-ID", "stale" ],
    name: "a flat list carrying the header in another case" },

  { expected: [ [ "accept", "application/json" ], [ STAMP_NAME, STAMP_VALUE ] ], headers: [[ "accept", "application/json" ]],
    name: "a tuple list without the header" },

  { expected: [ [ "accept", "application/json" ], [ STAMP_NAME, STAMP_VALUE ] ], headers: new Map([ [ "accept", "application/json" ], [ "x-correlation-id",
    "stale" ] ]), name: "a tuple iterable carrying the header in another case" }
];

describe("the header stamp interceptor", () => {

  for(const row of HEADER_CASES) {

    test("stamps " + row.name, () => {

      const seen: { handler: unknown; options: Dispatcher.DispatchOptions }[] = [];

      const wrapped = headerStampInterceptor(STAMP_NAME, STAMP_VALUE)((options, handler): boolean => {

        seen.push({ handler, options });

        return true;
      });

      const handler = { onResponseStart: (): void => { /* Never invoked: the dispatch below is a stand-in that answers nothing. */ } };
      const options: Dispatcher.DispatchOptions = { headers: row.headers, method: "GET", path: "/devices" };

      assert.equal(wrapped(options, handler), true);

      // Exactly one dispatch, carrying the handler and every other request field untouched. The header set is the only thing the stamp is entitled to change.
      assert.equal(seen.length, 1);

      const dispatched = expectAt(seen, 0, "a dispatch");

      assert.equal(dispatched.handler, handler);
      assert.equal(dispatched.options.method, "GET");
      assert.equal(dispatched.options.path, "/devices");
      assert.deepEqual(dispatched.options.headers, row.expected);

      // The stamp dispatches a copy and never mutates what the caller handed in, so the object going out is a different one.
      assert.notStrictEqual(dispatched.options, options);

      // The caller's own options object is left as it was, because it belongs to whoever dispatched the request rather than to the interceptor.
      assert.equal(options.headers, row.headers);
    });
  }
});

describe("a composed API dispatcher", () => {

  test("threads the caller's own retry policy through to the interceptor", async (t) => {

    const server = await startServer([ 418, 200 ]);

    const dispatcher = createApiDispatcher({ origin: server.origin, retry: { maxRetries: 2, maxTimeout: 5, minTimeout: 1, statusCodes: [418], timeoutFactor: 2 },
      userAgent: USER_AGENT });

    const drains: (() => Promise<void>)[] = [];

    t.after(async () => {

      await Promise.all(drains.map((drain) => drain()));
      await dispatcher.destroy();
      await server.close();
    });

    const response = await request(server.origin + "/devices", { dispatcher });

    drains.push(async (): Promise<void> => response.body.dump());

    /* A 418 is outside the vetted status list, so only the caller's own policy can produce a second attempt. A factory that quietly dropped the supplied object and
     * composed the defaults instead would surface the 418 after a single hit.
     */
    assert.equal(response.statusCode, 200);
    assert.equal(server.hits(), 2);
    assert.deepEqual(server.agents, [ USER_AGENT, USER_AGENT ]);
  });

  test("composes no retry interceptor at all when retries are declined", async (t) => {

    const server = await startServer([503]);
    const dispatcher = createApiDispatcher({ origin: server.origin, retry: false, userAgent: USER_AGENT });
    const drains: (() => Promise<void>)[] = [];

    t.after(async () => {

      await Promise.all(drains.map((drain) => drain()));
      await dispatcher.destroy();
      await server.close();
    });

    const response = await request(server.origin + "/devices", { dispatcher });

    drains.push(async (): Promise<void> => response.body.dump());

    // The 503 is an answer here rather than a fault, so it has to reach the caller undisturbed and unrepeated.
    assert.equal(response.statusCode, 503);
    assert.equal(server.hits(), 1);
    assert.deepEqual(server.agents, [USER_AGENT]);
  });

  test("retries a vetted status on the default policy", async (t) => {

    const server = await startServer([ 503, 200 ]);
    const dispatcher = createApiDispatcher({ origin: server.origin, userAgent: USER_AGENT });
    const drains: (() => Promise<void>)[] = [];

    t.after(async () => {

      await Promise.all(drains.map((drain) => drain()));
      await dispatcher.destroy();
      await server.close();
    });

    const response = await request(server.origin + "/devices", { dispatcher });

    drains.push(async (): Promise<void> => response.body.dump());

    /* The one phase that pays the default curve's first backoff, and the reason it exists: a server that only ever answers 200 cannot tell a composed interceptor
     * apart from one a truthiness slip left out entirely. The second hit is what proves the default path composed and retried.
     */
    assert.equal(response.statusCode, 200);
    assert.equal(server.hits(), 2);
    assert.deepEqual(server.agents, [ USER_AGENT, USER_AGENT ]);
  });

  test("settles a request waiting on a backoff once the dispatcher is destroyed", async (t) => {

    const server = await startServer([503]);

    const dispatcher = createApiDispatcher({ origin: server.origin, retry: { maxRetries: 1, maxTimeout: 50, minTimeout: 50, statusCodes: [503], timeoutFactor: 1 },
      userAgent: USER_AGENT });

    t.after(async () => {

      await server.close();
    });

    // The settlement is observed from the moment the request is made, so a rejection arriving while the destroy is in flight can never escape as an unhandled one.
    const settled = request(server.origin + "/devices", { dispatcher }).then(() => undefined, (error: unknown) => error);

    await server.firstHit;
    await dispatcher.destroy();

    const failure = await settled;

    /* Read straight off the error rather than through the classifier, so this phase proves what the transport does rather than what another module says about it.
     * Nothing is asserted about ordering: the destroy may interrupt the exchange before a backoff is ever scheduled or after, and both roads end here.
     */
    assert.ok(failure instanceof Error);
    assert.equal(("code" in failure) ? failure.code : undefined, "UND_ERR_DESTROYED");
    assert.equal(server.hits(), 1);
    assert.deepEqual(server.agents, [USER_AGENT]);
  });
});

// The connect channels the cancellation phases read, each filtered to the phase's own origin.
const DIAL_CHANNEL = "undici:client:beforeConnect";
const DIAL_FAILURE_CHANNEL = "undici:client:connectError";

/* The backoff the connect-backoff phases' own retry policy waits out, in milliseconds: short enough to keep the suite quick, and long enough that an abort lands well
 * inside it.
 */
const ROW_BACKOFF_MS = 150;

// The retry policy for a phase that retries a status: the vetted shape, with backoffs short enough that the retry costs the suite nothing.
const SHORT_STATUS_RETRY = { maxRetries: 2, maxTimeout: 5, minTimeout: 1, statusCodes: [503], timeoutFactor: 2 };

// The callbacks that end a request, of which a caller is handed exactly one.
const TERMINAL_CALLBACKS: readonly string[] = [ "onRequestUpgrade", "onResponseEnd", "onResponseError" ];

// The compositions a cancellation phase runs under when the retry interceptor's presence bears on what it shows.
const COMPOSITIONS: readonly { label: string; retry: ApiDispatcherOptions["retry"] }[] = [

  { label: "under the default retry policy", retry: undefined },
  { label: "with no retry interceptor", retry: false }
];

// A fresh reason for each abort, in the shape a caller's own deadline hands the transport, so a phase compares against the exact value it aborted with.
function deadlineReason(): DOMException {

  return new DOMException("The caller's budget ran out.", "TimeoutError");
}

// The host a connect channel message names. The channel types its payload as unknown, so each step of the read is checked rather than assumed.
function publishedHost(message: unknown): string | undefined {

  if((typeof message !== "object") || (message === null) || !("connectParams" in message)) {

    return undefined;
  }

  const params = message.connectParams;

  return ((typeof params === "object") && (params !== null) && ("host" in params) && (typeof params.host === "string")) ? params.host : undefined;
}

/* Count the messages one of the transport's connect channels publishes for an origin. The channels are process-wide, so only the messages naming this origin's host
 * are counted, and the subscription ends with the phase.
 */
function countPublished(t: TestContext, channel: string, origin: string): () => number {

  const host = new URL(origin).host;
  let count = 0;

  const onMessage = (message: unknown): void => {

    if(publishedHost(message) === host) {

      count++;
    }
  };

  subscribe(channel, onMessage);

  t.after((): void => {

    unsubscribe(channel, onMessage);
  });

  return (): number => count;
}

// How a request settled.
type Outcome<T> = { readonly error: unknown; readonly kind: "rejected" } | { readonly kind: "resolved"; readonly value: T };

/* A request observed from the moment it is made, so a rejection arriving while the phase is busy elsewhere is never an unhandled one, and readable at any moment, so
 * a phase can ask whether it has settled yet without waiting on it.
 */
interface Tracked<T> {

  outcome: Outcome<T> | undefined;
}

function track<T>(promise: Promise<T>): Tracked<T> {

  const tracked: Tracked<T> = { outcome: undefined };

  void promise.then((value) => {

    tracked.outcome = { kind: "resolved", value };
  }, (error: unknown) => {

    tracked.outcome = { error, kind: "rejected" };
  });

  return tracked;
}

// Wait for a tracked request to settle, within the shared bound, and answer how it settled.
async function settledOf<T>(tracked: Tracked<T>, description: string): Promise<Outcome<T>> {

  await waitUntil(() => tracked.outcome !== undefined, { description });

  return tracked.outcome ?? assert.fail("The wait for " + description + " ended with nothing settled.");
}

// The value a tracked request rejects with. A request that resolves instead fails the phase.
async function rejectionOf(tracked: Tracked<unknown>, description: string): Promise<unknown> {

  const outcome = await settledOf(tracked, description);

  return (outcome.kind === "rejected") ? outcome.error : assert.fail("The request resolved while waiting for " + description + ".");
}

// The value a tracked request resolves with. A request that rejects instead fails the phase with what it rejected with.
async function resolutionOf<T>(tracked: Tracked<T>, description: string): Promise<T> {

  const outcome = await settledOf(tracked, description);

  if(outcome.kind === "rejected") {

    throw outcome.error;
  }

  return outcome.value;
}

// The code an error carries, read without assuming the value is an error at all.
function errorCode(error: unknown): unknown {

  return ((error instanceof Error) && ("code" in error)) ? error.code : undefined;
}

// One exchange a held server has taken: the request as it arrived, the response the phase writes when it chooses, and what the server saw of the client.
interface HeldExchange {

  readonly bodyBytes: () => number;
  readonly cut: () => boolean;
  readonly path: string;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
}

// A loopback server that writes nothing on its own: each request is handed to the phase as an exchange, so the phase decides when, and whether, it is answered.
interface HeldServer {

  readonly close: () => Promise<void>;
  readonly closedConnections: () => number;
  readonly connections: () => number;
  readonly exchanges: readonly HeldExchange[];
  readonly origin: string;
}

// What a held server does with each exchange and each upgrade as it arrives, beyond recording it.
interface HeldServerOptions {

  readonly answer?: (exchange: HeldExchange, index: number) => void;
  readonly upgrade?: (socket: Duplex) => void;
}

/* Start a held server on a kernel-assigned loopback port, extending the scripted server above for phases whose answer has to wait. It counts each connection it
 * accepts and each that closes, and records, for every exchange, the request body bytes it received and whether the client went away before the response finished,
 * which is what a server observes of an attempt torn down mid-flight.
 */
async function startHeldServer({ answer, upgrade: onUpgrade }: HeldServerOptions = {}): Promise<HeldServer> {

  const exchanges: HeldExchange[] = [];
  const upgraded: Duplex[] = [];
  let closedConnections = 0;
  let connections = 0;

  const server = createServer((incoming, response) => {

    let bodyBytes = 0;
    let cut = false;

    incoming.on("data", (chunk: Buffer) => {

      bodyBytes += chunk.length;
    });

    response.on("close", () => {

      cut = !response.writableFinished;
    });

    const exchange: HeldExchange = { bodyBytes: (): number => bodyBytes, cut: (): boolean => cut, path: incoming.url ?? "", request: incoming, response };

    exchanges.push(exchange);
    answer?.(exchange, exchanges.length - 1);
  });

  server.on("connection", (socket) => {

    connections++;

    socket.on("close", () => {

      closedConnections++;
    });
  });

  // An upgraded socket leaves the server's own connection tracking, so the server keeps it to destroy at close.
  if(onUpgrade !== undefined) {

    server.on("upgrade", (_incoming, socket) => {

      upgraded.push(socket);
      onUpgrade(socket);
    });
  }

  const port = await listenOnLoopback(server);

  return {

    // A held response keeps its connection open for as long as the phase leaves it, so every connection is ended before the server stops listening.
    close: async (): Promise<void> => {

      for(const socket of upgraded) {

        socket.destroy();
      }

      server.closeAllConnections();
      await stopListening(server);
    },

    closedConnections: (): number => closedConnections,
    connections: (): number => connections,
    exchanges,
    origin: "http://127.0.0.1:" + port.toString()
  };
}

// One cancellation phase's wiring: a held server, a dispatcher over it, and the count of the dials its pool makes, each released when the phase ends.
interface HeldRig {

  readonly dials: () => number;
  readonly dispatcher: Dispatcher;
  readonly server: HeldServer;
}

async function startHeldRig(t: TestContext, { retry, ...serverOptions }: HeldServerOptions & Pick<ApiDispatcherOptions, "retry"> = {}): Promise<HeldRig> {

  const server = await startHeldServer(serverOptions);
  const dispatcher = createApiDispatcher({ origin: server.origin, retry, userAgent: USER_AGENT });
  const dials = countPublished(t, DIAL_CHANNEL, server.origin);

  t.after(async () => {

    await dispatcher.destroy();
    await server.close();
  });

  return { dials, dispatcher, server };
}

// Dispatch options carrying a signal. The transport's options type leaves the member out though its request APIs put one there, so a raw dispatch states it here.
type SignalledOptions = Dispatcher.DispatchOptions & { readonly signal?: AbortSignal | EventEmitter };

/* A raw dispatch handler's record of every callback it was handed, in order, with the errors and controllers its `onResponseError` received and the body it was
 * given. The callbacks that report progress without changing the request's course - a body chunk sent, the request sent, the response begun - are kept apart from
 * the rest, so a phase reads the request's course and its progress separately.
 */
interface Recorder {

  readonly body: () => string;
  readonly calls: readonly string[];
  readonly controllers: readonly Dispatcher.DispatchController[];
  readonly failures: readonly unknown[];
  readonly handler: Dispatcher.DispatchHandler;
  readonly progress: readonly string[];
  readonly terminals: () => readonly string[];
}

function recordingHandler(): Recorder {

  const calls: string[] = [];
  const chunks: Buffer[] = [];
  const controllers: Dispatcher.DispatchController[] = [];
  const failures: unknown[] = [];
  const progress: string[] = [];

  return {

    body: (): string => Buffer.concat(chunks).toString(),
    calls,
    controllers,
    failures,

    handler: {

      onBodySent: (): void => {

        progress.push("onBodySent");
      },

      onRequestSent: (): void => {

        progress.push("onRequestSent");
      },

      onRequestStart: (): void => {

        calls.push("onRequestStart");
      },

      onResponseData: (_controller, chunk): void => {

        calls.push("onResponseData");
        chunks.push(chunk);
      },

      onResponseEnd: (): void => {

        calls.push("onResponseEnd");
      },

      onResponseError: (controller, error): void => {

        calls.push("onResponseError");
        controllers.push(controller);
        failures.push(error);
      },

      onResponseStart: (_controller, statusCode): void => {

        calls.push("onResponseStart:" + statusCode.toString());
      },

      onResponseStarted: (): void => {

        progress.push("onResponseStarted");
      }
    },

    progress,
    terminals: (): readonly string[] => calls.filter((call) => TERMINAL_CALLBACKS.includes(call))
  };
}

/* The controller a settled request hands its caller reads aborted, with the error it was settled with, and stays that way whatever it is asked, since nothing
 * beneath a settled request is left for it to act on.
 */
function assertSettledController(controller: Dispatcher.DispatchController, error: unknown): void {

  assert.equal(controller.aborted, true);
  assert.equal(controller.reason, error);

  controller.pause();
  controller.resume();
  controller.abort(new Error("A late abort of a settled request."));

  assert.equal(controller.aborted, true);
  assert.equal(controller.paused, false);
  assert.equal(controller.reason, error);
}

/* Requests made against a pool in one closing state: a live signal and none take the pool's own refusal, and a signal that has already aborted is answered with its
 * reason before the pool sees the request.
 */
async function assertRefused(dispatcher: Dispatcher, origin: string, code: string): Promise<void> {

  const live = new AbortController();
  const aborted = new AbortController();
  const reason = deadlineReason();

  aborted.abort(reason);

  const withLive = track(request(origin + "/live", { dispatcher, signal: live.signal }));

  // The pool's refusal reaches the caller inside the dispatch itself, so nothing of the gate's is left on the signal by the time the call returns.
  assert.equal(getEventListeners(live.signal, "abort").length, 0);
  assert.equal(errorCode(await rejectionOf(withLive, "the request with a live signal to be refused")), code);
  assert.equal(errorCode(await rejectionOf(track(request(origin + "/none", { dispatcher })), "the request with no signal to be refused")), code);
  assert.equal(await rejectionOf(track(request(origin + "/aborted", { dispatcher, signal: aborted.signal })), "the request already aborted to reject"), reason);
  assert.equal(getEventListeners(live.signal, "abort").length, 0);
}

describe("a composed API dispatcher answering a request's own signal", () => {

  for(const { label, retry } of COMPOSITIONS) {

    test("releases a request queued behind a held one at its abort, and the pool makes no dial for it, " + label, async (t) => {

      await assertNoUnhandledRejections(async () => {

        const { dials, dispatcher, server } = await startHeldRig(t, { retry });
        const first = track(request(server.origin + "/first", { dispatcher }));

        await waitUntil(() => server.exchanges.length === 1, { description: "the first request to reach the server" });

        const controller = new AbortController();
        const reason = deadlineReason();
        const queued = track(request(server.origin + "/queued", { dispatcher, signal: controller.signal }));

        controller.abort(reason);

        // The caller is released at its abort, with the very value it aborted with, while the request ahead of it still holds the only connection.
        assert.equal(await rejectionOf(queued, "the queued request to reject"), reason);
        assert.equal(first.outcome, undefined);

        const third = track(request(server.origin + "/third", { dispatcher }));

        expectAt(server.exchanges, 0, "the first exchange").response.end("first");
        await waitUntil(() => server.exchanges.length === 2, { description: "the third request to reach the server" });
        expectAt(server.exchanges, 1, "the third exchange").response.end("third");

        await (await resolutionOf(first, "the first request to complete")).body.dump();
        await (await resolutionOf(third, "the third request to complete")).body.dump();

        /* The aborted request never reached the server, and the third went out on the connection the first was answered on. Without the client that drops an aborted
         * request, the queue hands the aborted one to that connection, whose teardown costs the third a dial of its own.
         */
        assert.deepEqual(server.exchanges.map((exchange) => exchange.path), [ "/first", "/third" ]);
        assert.equal(dials(), 1);
      });
    });

    test("completes a request carrying a live signal with its status, headers and exact body, and leaves no listener on the signal, " + label, async (t) => {

      const { dispatcher, server } = await startHeldRig(t, {

        answer: (exchange) => {

          exchange.response.writeHead(200, { "content-type": "application/octet-stream", "x-phase": "completed" });
          exchange.response.end(Buffer.from([ 0, 1, 2, 253, 254, 255 ]));
        },

        retry
      });

      const controller = new AbortController();
      const response = await resolutionOf(track(request(server.origin + "/completed", { dispatcher, signal: controller.signal })), "the response to start");
      const body = await resolutionOf(track(response.body.arrayBuffer()), "the body to be read");

      await waitUntil(() => response.body.closed, { description: "the response body to close" });

      assert.equal(response.statusCode, 200);
      assert.equal(response.headers["content-type"], "application/octet-stream");
      assert.equal(response.headers["x-phase"], "completed");
      assert.deepEqual([...new Uint8Array(body)], [ 0, 1, 2, 253, 254, 255 ]);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    });

    test("streams a response carrying a live signal to its end, and leaves no listener on the signal, " + label, async (t) => {

      const { dispatcher, server } = await startHeldRig(t, {

        answer: (exchange) => {

          exchange.response.writeHead(200, { "content-type": "text/plain", "x-phase": "streamed" });
          exchange.response.write("one,");

          setImmediate(() => {

            exchange.response.write("two,");

            setImmediate(() => {

              exchange.response.end("three");
            });
          });
        },

        retry
      });

      const chunks: Buffer[] = [];
      const controller = new AbortController();
      let received: Dispatcher.StreamFactoryData["headers"] = {};
      let status = 0;

      await resolutionOf(track(stream(server.origin + "/streamed", { dispatcher, method: "GET", signal: controller.signal }, ({ headers, statusCode }) => {

        received = headers;
        status = statusCode;

        return new Writable({

          write: (chunk: Buffer, _encoding, callback): void => {

            chunks.push(chunk);
            callback();
          }
        });
      })), "the stream to finish");

      assert.equal(status, 200);
      assert.equal(received["content-type"], "text/plain");
      assert.equal(received["x-phase"], "streamed");
      assert.equal(received["transfer-encoding"], "chunked");
      assert.equal(Buffer.concat(chunks).toString(), "one,two,three");
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    });

    test("errors a started response's held body with the reason when its signal aborts, as the transport does, " + label, async (t) => {

      const { dispatcher, server } = await startHeldRig(t, { retry });
      const controller = new AbortController();
      const reason = deadlineReason();
      const pending = track(request(server.origin + "/held-body", { dispatcher, signal: controller.signal }));

      await waitUntil(() => server.exchanges.length === 1, { description: "the request to reach the server" });

      const exchange = expectAt(server.exchanges, 0, "the held exchange");

      exchange.response.writeHead(200, { "content-type": "text/plain" });
      exchange.response.write("partial");

      const response = await resolutionOf(pending, "the response to start");
      const body = track(response.body.text());

      controller.abort(reason);

      assert.equal(await rejectionOf(body, "the held body to error"), reason);
      await waitUntil(() => exchange.cut(), { description: "the server to see the response cut off" });
    });

    test("rejects a request whose body is being written with the reason when its signal aborts, as the transport does, " + label, async (t) => {

      const { dispatcher, server } = await startHeldRig(t, { retry });
      const body = new Readable({ read: (): void => { /* The phase pushes the body by hand. */ } });
      const controller = new AbortController();
      const reason = deadlineReason();

      body.push(Buffer.alloc(1024, "a"));

      const pending = track(request(server.origin + "/upload", { body, dispatcher, method: "PUT", signal: controller.signal }));

      await waitUntil(() => server.exchanges.at(0)?.bodyBytes() === 1024, { description: "the first chunk of the body to arrive" });
      controller.abort(reason);

      const exchange = expectAt(server.exchanges, 0, "the upload exchange");

      assert.equal(await rejectionOf(pending, "the upload to reject"), reason);
      await waitUntil(() => exchange.cut(), { description: "the server to see the upload cut off" });
      assert.equal(exchange.request.complete, false);
    });
  }

  test("rejects a request whose signal has already aborted with that reason, sending nothing and dialing nothing", async (t) => {

    const { dials, dispatcher, server } = await startHeldRig(t);
    const controller = new AbortController();
    const reason = deadlineReason();

    controller.abort(reason);

    assert.equal(await rejectionOf(track(request(server.origin + "/late", { dispatcher, signal: controller.signal })), "the request to reject"), reason);
    assert.equal(server.connections(), 0);
    assert.equal(server.exchanges.length, 0);
    assert.equal(dials(), 0);
  });

  for(const { label, reason: makeReason } of [ { label: "a deadline's own reason", reason: deadlineReason },
    { label: "a reason carrying no code", reason: (): Error => new HbpuAbortError("timeout") } ]) {

    test("releases a request waiting out a connect backoff at its abort with " + label + ", and the retry beneath it dials and consults no further", async (t) => {

      await assertNoUnhandledRejections(async () => {

        const origin = "http://127.0.0.1:" + (await freePort()).toString();
        const dials = countPublished(t, DIAL_CHANNEL, origin);
        const dialFailures = countPublished(t, DIAL_FAILURE_CHANNEL, origin);
        const backoffs: Disposable[] = [];
        const consults: number[] = [];
        let backoffElapsed = false;

        /* The phase's own retry policy, consulted before each backoff. It retries once and gives up after, so a ladder still running beneath a released caller shows
         * as a further consult rather than running without end.
         */
        const dispatcher = createApiDispatcher({ origin, retry: { retry: (error, { state }, callback): void => {

          consults.push(state.counter);

          backoffs.push(systemClock.schedule(() => {

            backoffElapsed = true;
            callback((consults.length > 1) ? error : null);
          }, ROW_BACKOFF_MS));
        } }, userAgent: USER_AGENT });

        t.after(async () => {

          for(const backoff of backoffs) {

            backoff[Symbol.dispose]();
          }

          await dispatcher.destroy();
        });

        const controller = new AbortController();
        const reason = makeReason();
        const pending = track(request(origin + "/refused", { dispatcher, signal: controller.signal }));

        await waitUntil(() => (dialFailures() === 1) && (consults.length === 1), { description: "the first dial to fail and its backoff to begin" });
        controller.abort(reason);

        // The caller is released inside the backoff rather than when it elapses.
        assert.equal(await rejectionOf(pending, "the request to reject"), reason);
        assert.equal(backoffElapsed, false);
        assert.equal(dials(), 1);

        /* The one fixed wait the cancellation phases allow, ruled for this phase alone, because an absence of dials and consults across a backoff can be shown no other
         * way on a real socket. It spans a multiple of the backoff, so the backoff pending at the abort has fired and its re-dispatch has been answered.
         */
        await systemClock.delay(ROW_BACKOFF_MS * 3);

        // The backoff fired into the client that drops the request, which settled it as aborted, so the policy was not consulted again and nothing was dialed.
        assert.equal(backoffElapsed, true);
        assert.equal(dials(), 1);
        assert.deepEqual(consults, [1]);
      });
    });
  }

  test("retries a vetted status beneath a live signal, and the handler above the retry sees each attempt start", async (t) => {

    const { dispatcher, server } = await startHeldRig(t, {

      answer: (exchange, index) => {

        exchange.response.writeHead((index === 0) ? 503 : 200, { "content-type": "text/plain" });
        exchange.response.end("ok");
      },

      retry: SHORT_STATUS_RETRY
    });

    const controller = new AbortController();
    const recorder = recordingHandler();
    const options: SignalledOptions = { method: "GET", path: "/status", signal: controller.signal };

    dispatcher.dispatch(options, recorder.handler);
    await waitUntil(() => recorder.terminals().length > 0, { description: "the request to end" });

    // The caller sees the success the retry earned, after an onRequestStart for each attempt, and the signal is left as it was found.
    assert.deepEqual(recorder.calls, [ "onRequestStart", "onRequestStart", "onResponseStart:200", "onResponseData", "onResponseEnd" ]);
    assert.equal(server.exchanges.length, 2);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });

  test("releases a request whose retried attempt waits in the pool's queue at its abort, and that attempt never reaches the server", async (t) => {

    const consults: (() => void)[] = [];

    const { dials, dispatcher, server } = await startHeldRig(t, {

      // The first request is answered with a status the policy retries, and every later exchange is held by the phase.
      answer: (exchange, index) => {

        if(index === 0) {

          exchange.response.writeHead(503, { "content-type": "text/plain" });
          exchange.response.end("busy");
        }
      },

      // The policy holds each consult until the phase releases it.
      retry: { retry: (_error, _context, callback): void => {

        consults.push(() => {

          callback(null);
        });
      } }
    });

    const controller = new AbortController();
    const reason = deadlineReason();
    const first = track(request(server.origin + "/first", { dispatcher, signal: controller.signal }));

    await waitUntil(() => consults.length === 1, { description: "the retry policy to be consulted on the first request's status" });

    const second = track(request(server.origin + "/second", { dispatcher }));

    await waitUntil(() => server.exchanges.length === 2, { description: "the second request to take the connection" });

    // Released, the consult re-dispatches the first request, whose retried attempt waits in the pool's queue behind the second, held on the only connection.
    expectAt(consults, 0, "the held consult")();
    await settle();
    controller.abort(reason);

    // The gate is still armed though an earlier attempt started, so the caller is released at its abort rather than when the queue reaches the retried attempt.
    assert.equal(await rejectionOf(first, "the first request to reject"), reason);
    assert.equal(second.outcome, undefined);

    expectAt(server.exchanges, 1, "the second exchange").response.end("second");
    await (await resolutionOf(second, "the second request to complete")).body.dump();
    await settle();

    assert.deepEqual(server.exchanges.map((exchange) => exchange.path), [ "/first", "/second" ]);
    assert.equal(dials(), 1);
  });

  test("completes a burst through one connection in the order it was sent, with one dial, every request carrying a live signal", async (t) => {

    const { dials, dispatcher, server } = await startHeldRig(t, {

      answer: (exchange) => {

        exchange.response.end(exchange.path);
      }
    });

    const completed: string[] = [];
    const paths = [ "/r0", "/r1", "/r2", "/r3", "/r4" ];

    const burst = paths.map((path) => track(request(server.origin + path, { dispatcher, signal: new AbortController().signal }).then(async (response) => {

      completed.push(await response.body.text());
    })));

    await waitUntil(() => burst.every((entry) => entry.outcome !== undefined), { description: "every request in the burst to complete" });

    // Each has settled already, so this reads every outcome at once and fails the phase on any rejection.
    await Promise.all(burst.map(async (entry) => resolutionOf(entry, "a request in the burst to complete")));

    assert.deepEqual(completed, paths);
    assert.equal(dials(), 1);
  });

  test("hands a raw caller queued behind a held request one terminal callback at its abort, and no onRequestStart", async (t) => {

    await assertNoUnhandledRejections(async () => {

      const { dispatcher, server } = await startHeldRig(t);
      const first = track(request(server.origin + "/first", { dispatcher }));

      await waitUntil(() => server.exchanges.length === 1, { description: "the first request to reach the server" });

      const controller = new AbortController();
      const reason = deadlineReason();
      const recorder = recordingHandler();
      const options: SignalledOptions = { method: "GET", path: "/queued", signal: controller.signal };

      dispatcher.dispatch(options, recorder.handler);
      controller.abort(reason);

      // The caller is answered inside the abort itself, through an inert controller reading aborted.
      assert.deepEqual(recorder.calls, ["onResponseError"]);
      assert.equal(expectAt(recorder.failures, 0, "the error the caller was handed"), reason);
      assertSettledController(expectAt(recorder.controllers, 0, "the controller the caller was handed"), reason);

      // The queue reaching the request drops it beneath the gate, and the third request, queued behind it, is what shows the queue has moved past it.
      const third = track(request(server.origin + "/third", { dispatcher }));

      expectAt(server.exchanges, 0, "the first exchange").response.end("first");
      await waitUntil(() => server.exchanges.length === 2, { description: "the third request to reach the server" });
      expectAt(server.exchanges, 1, "the third exchange").response.end("third");

      await (await resolutionOf(first, "the first request to complete")).body.dump();
      await (await resolutionOf(third, "the third request to complete")).body.dump();

      assert.deepEqual(recorder.calls, ["onResponseError"]);
    });
  });

  test("hands a raw caller whose signal has already aborted one terminal callback at the call, and no onRequestStart", async (t) => {

    const { dispatcher } = await startHeldRig(t);
    const controller = new AbortController();
    const reason = deadlineReason();
    const recorder = recordingHandler();
    const options: SignalledOptions = { method: "GET", path: "/late", signal: controller.signal };

    controller.abort(reason);

    assert.equal(dispatcher.dispatch(options, recorder.handler), true);
    assert.deepEqual(recorder.calls, ["onResponseError"]);
    assert.equal(expectAt(recorder.failures, 0, "the error the caller was handed"), reason);
    assertSettledController(expectAt(recorder.controllers, 0, "the controller the caller was handed"), reason);
  });

  test("hands a raw caller waiting out a connect backoff one terminal callback at its abort, and none when the backoff fires", async (t) => {

    await assertNoUnhandledRejections(async () => {

      const origin = "http://127.0.0.1:" + (await freePort()).toString();
      const dialFailures = countPublished(t, DIAL_FAILURE_CHANNEL, origin);
      const backoffs: Disposable[] = [];
      const consults: number[] = [];
      let backoffElapsed = false;

      // The same once-only policy as the backoff phases above, so a ladder still running beneath the released caller would show as a further consult.
      const dispatcher = createApiDispatcher({ origin, retry: { retry: (error, { state }, callback): void => {

        consults.push(state.counter);

        backoffs.push(systemClock.schedule(() => {

          backoffElapsed = true;
          callback((consults.length > 1) ? error : null);
        }, ROW_BACKOFF_MS));
      } }, userAgent: USER_AGENT });

      t.after(async () => {

        for(const backoff of backoffs) {

          backoff[Symbol.dispose]();
        }

        await dispatcher.destroy();
      });

      const controller = new AbortController();
      const reason = deadlineReason();
      const recorder = recordingHandler();
      const options: SignalledOptions = { method: "GET", path: "/refused", signal: controller.signal };

      dispatcher.dispatch(options, recorder.handler);
      await waitUntil(() => (dialFailures() === 1) && (consults.length === 1), { description: "the first dial to fail and its backoff to begin" });
      controller.abort(reason);

      assert.deepEqual(recorder.calls, ["onResponseError"]);
      assert.equal(expectAt(recorder.failures, 0, "the error the caller was handed"), reason);

      // The backoff's re-dispatch is settled beneath the gate when it fires, inside the timer's own turn, so once it has fired nothing further can reach the caller.
      await waitUntil(() => backoffElapsed, { description: "the backoff pending at the abort to fire" });
      await settle();

      assert.deepEqual(recorder.calls, ["onResponseError"]);
      assert.deepEqual(consults, [1]);
    });
  });

  for(const { label, retry } of COMPOSITIONS) {

    test("leaves a raw caller's started response to the transport at the abort, so its held body runs to its end with no listener left, " + label, async (t) => {

      const { dispatcher, server } = await startHeldRig(t, { retry });
      const controller = new AbortController();
      const recorder = recordingHandler();
      const options: SignalledOptions = { method: "GET", path: "/raw-held", signal: controller.signal };

      dispatcher.dispatch(options, recorder.handler);
      await waitUntil(() => server.exchanges.length === 1, { description: "the request to reach the server" });

      const exchange = expectAt(server.exchanges, 0, "the held exchange");

      exchange.response.writeHead(200, { "content-type": "text/plain" });
      exchange.response.write("partial,");
      await waitUntil(() => recorder.calls.includes("onResponseData"), { description: "the first body chunk to reach the caller" });

      // The response has started, so the gate has stood down and released its listener: the abort is the transport's to handle, and a raw caller does not listen.
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);

      controller.abort(deadlineReason());
      exchange.response.end("rest");

      await waitUntil(() => recorder.terminals().length > 0, { description: "the response to end" });
      await settle();

      assert.deepEqual(recorder.terminals(), ["onResponseEnd"]);
      assert.equal(recorder.body(), "partial,rest");

      /* Every progress callback that reaches the gate reaches the caller. The retry interceptor hands nothing up for the response beginning, so only a dispatcher
       * composed without it shows that callback at all.
       */
      assert.deepEqual(recorder.progress, (retry === false) ? [ "onRequestSent", "onResponseStarted" ] : ["onRequestSent"]);
    });
  }

  test("tears down a raw caller's attempt whose body is being written at the abort, and hands the caller one terminal callback with the reason", async (t) => {

    const { dispatcher, server } = await startHeldRig(t);
    const body = new Readable({ read: (): void => { /* The phase pushes the body by hand. */ } });
    const controller = new AbortController();
    const reason = deadlineReason();
    const recorder = recordingHandler();
    const options: SignalledOptions = { body, method: "PUT", path: "/raw-upload", signal: controller.signal };

    body.push(Buffer.alloc(1024, "a"));
    dispatcher.dispatch(options, recorder.handler);
    await waitUntil(() => server.exchanges.at(0)?.bodyBytes() === 1024, { description: "the first chunk of the body to arrive" });

    // The chunk's progress reached the caller while the request waited on its response.
    assert.deepEqual(recorder.progress, ["onBodySent"]);

    controller.abort(reason);

    assert.deepEqual(recorder.terminals(), ["onResponseError"]);
    assert.equal(expectAt(recorder.failures, 0, "the error the caller was handed"), reason);

    // The attempt itself is torn down, not just its caller answered: the server sees the upload cut off before its body completes.
    const exchange = expectAt(server.exchanges, 0, "the upload exchange");

    await waitUntil(() => exchange.cut(), { description: "the server to see the upload cut off" });
    await settle();

    assert.equal(exchange.request.complete, false);
    assert.equal(body.destroyed, true);
    assert.deepEqual(recorder.terminals(), ["onResponseError"]);
  });

  test("keeps the gate armed through an informational response, so an abort after it releases a raw caller and tears down the attempt", async (t) => {

    const { dispatcher, server } = await startHeldRig(t, {

      answer: (exchange) => {

        exchange.response.writeEarlyHints({ link: "</style.css>; rel=preload; as=style" });
      }
    });

    const controller = new AbortController();
    const reason = deadlineReason();
    const recorder = recordingHandler();
    const options: SignalledOptions = { method: "GET", path: "/hints", signal: controller.signal };

    dispatcher.dispatch(options, recorder.handler);
    await waitUntil(() => recorder.calls.includes("onResponseStart:103"), { description: "the early hints to reach the caller" });
    controller.abort(reason);

    // The final response has not started, so the caller is answered at the abort itself.
    assert.deepEqual(recorder.calls, [ "onRequestStart", "onResponseStart:103", "onResponseError" ]);
    assert.equal(expectAt(recorder.failures, 0, "the error the caller was handed"), reason);

    await waitUntil(() => expectAt(server.exchanges, 0, "the hinted exchange").cut(), { description: "the server to see the request torn down" });
    await settle();

    assert.deepEqual(recorder.calls, [ "onRequestStart", "onResponseStart:103", "onResponseError" ]);
  });

  test("aborts the attempt a fresh connection takes when its request was aborted in the tick it was made, so the server sees no request", async (t) => {

    await assertNoUnhandledRejections(async () => {

      const { dials, dispatcher, server } = await startHeldRig(t);
      const controller = new AbortController();
      const reason = deadlineReason();
      const pending = track(request(server.origin + "/same-tick", { dispatcher, signal: controller.signal }));

      controller.abort(reason);

      assert.equal(await rejectionOf(pending, "the request to reject"), reason);

      // The dial was already under way, so it completes, and the connection's first act is to abort the attempt rather than write it.
      await waitUntil(() => (server.connections() === 1) && (server.closedConnections() === 1), { description: "the connection to open and close" });

      assert.equal(server.exchanges.length, 0);
      assert.equal(dials(), 1);
    });
  });

  test("passes a throw from beneath to the dispatch's own caller, and leaves no listener on the signal", async (t) => {

    const { dispatcher } = await startHeldRig(t);
    const controller = new AbortController();

    const headers: Iterable<[ string, string ]> = {

      [Symbol.iterator]: (): Iterator<[ string, string ]> => {

        throw new Error("The header set cannot be read.");
      }
    };

    const options: SignalledOptions = { headers, method: "GET", path: "/throws", signal: controller.signal };

    assert.throws(() => dispatcher.dispatch(options, recordingHandler().handler), { message: "The header set cannot be read." });
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });

  test("rejects a request whose dial fails beneath a live signal with the connect error, and leaves no listener on the signal", async (t) => {

    const origin = "http://127.0.0.1:" + (await freePort()).toString();
    const dispatcher = createApiDispatcher({ origin, retry: false, userAgent: USER_AGENT });

    t.after(async () => {

      await dispatcher.destroy();
    });

    const controller = new AbortController();

    assert.equal(errorCode(await rejectionOf(track(request(origin + "/refused", { dispatcher, signal: controller.signal })), "the request to reject")), "ECONNREFUSED");
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });

  test("completes an upgrade carrying a live signal with a usable socket, and leaves no listener on the signal", async (t) => {

    const { dispatcher, server } = await startHeldRig(t, {

      upgrade: (socket) => {

        socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\n");

        socket.on("data", (data: Buffer) => {

          socket.write(data);
        });
      }
    });

    const controller = new AbortController();
    const upgrading = track(upgrade(server.origin + "/upgrade", { dispatcher, protocol: "echo", signal: controller.signal }));
    const upgraded = await resolutionOf(upgrading, "the upgrade to complete");
    const echoed: Buffer[] = [];

    t.after(() => {

      upgraded.socket.destroy();
    });

    upgraded.socket.on("data", (data: Buffer) => {

      echoed.push(data);
    });

    upgraded.socket.write("ping");
    await waitUntil(() => Buffer.concat(echoed).toString() === "ping", { description: "the upgraded socket to echo" });

    assert.equal(upgraded.headers["upgrade"], "echo");
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });

  test("leaves a request whose signal is an event emitter to the transport's own path", async (t) => {

    const { dispatcher, server } = await startHeldRig(t, {

      answer: (exchange, index) => {

        exchange.response.writeHead(200, { "content-type": "text/plain" });

        if(index === 0) {

          exchange.response.end("fine");

          return;
        }

        exchange.response.write("part");
      }
    });

    const silent = await resolutionOf(track(request(server.origin + "/silent", { dispatcher, signal: new EventEmitter() })), "the silent request to start");

    assert.equal(silent.statusCode, 200);
    assert.equal(await resolutionOf(track(silent.body.text()), "the silent request's body to be read"), "fine");

    const emitter = new EventEmitter();
    const started = await resolutionOf(track(request(server.origin + "/emitted", { dispatcher, signal: emitter })), "the second response to start");
    const body = track(started.body.text());

    emitter.emit("abort");

    // An emitter carries no reason, so the transport answers its abort with its own request-aborted error.
    const failure = await rejectionOf(body, "the second body to error");

    assert.ok(failure instanceof errors.RequestAbortedError);
    assert.equal(failure.code, "UND_ERR_ABORTED");
  });

  test("answers requests made during close(), after close() and after destroy() as the pool does, and one already aborted with its reason", async (t) => {

    const { dispatcher, server } = await startHeldRig(t);
    const held = track(request(server.origin + "/held", { dispatcher }));

    await waitUntil(() => server.exchanges.length === 1, { description: "the held request to reach the server" });

    const closing = track(dispatcher.close());

    await assertRefused(dispatcher, server.origin, "UND_ERR_CLOSED");

    expectAt(server.exchanges, 0, "the held exchange").response.end("held");
    await (await resolutionOf(held, "the held request to complete")).body.dump();
    await resolutionOf(closing, "the close to finish");
    await assertRefused(dispatcher, server.origin, "UND_ERR_DESTROYED");

    const destroyed = createApiDispatcher({ origin: server.origin, userAgent: USER_AGENT });

    await destroyed.destroy();
    await assertRefused(destroyed, server.origin, "UND_ERR_DESTROYED");
    assert.deepEqual(server.exchanges.map((exchange) => exchange.path), ["/held"]);
  });

  test("hands a raw caller dispatching after destroy() the controller exactly as the pool passed it, null, beside the destroyed error", async (t) => {

    /* Composed without the retry interceptor, so the pool's refusal reaches the gate directly: with it, the retry handler hands its own controller up in place of
     * the pool's. The gate's member reads nothing from the controller, so the caller is handed the pool's null untouched.
     */
    const { dispatcher } = await startHeldRig(t, { retry: false });
    const controller = new AbortController();
    const recorder = recordingHandler();
    const options: SignalledOptions = { method: "GET", path: "/after-destroy", signal: controller.signal };

    await dispatcher.destroy();
    dispatcher.dispatch(options, recorder.handler);

    assert.deepEqual(recorder.calls, ["onResponseError"]);
    assert.equal(expectAt(recorder.controllers, 0, "the controller the caller was handed"), null);
    assert.equal(errorCode(expectAt(recorder.failures, 0, "the error the caller was handed")), "UND_ERR_DESTROYED");
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });

  test("releases a request in a connect backoff at its abort, and after destroy() its retry consults once more and the gate drops the refusal", async (t) => {

    await assertNoUnhandledRejections(async () => {

      const origin = "http://127.0.0.1:" + (await freePort()).toString();
      const dials = countPublished(t, DIAL_CHANNEL, origin);
      const dialFailures = countPublished(t, DIAL_FAILURE_CHANNEL, origin);
      const consults: unknown[] = [];
      const held: (() => void)[] = [];

      /* The phase's own retry policy holds its first consult until the phase releases it, and passes every later error up, so the refusal the destroyed pool
       * answers the released retry with reaches the gate rather than another backoff.
       */
      const dispatcher = createApiDispatcher({ origin, retry: { retry: (error, _context, callback): void => {

        consults.push(errorCode(error));

        if(consults.length > 1) {

          callback(error);

          return;
        }

        held.push(() => {

          callback(null);
        });
      } }, userAgent: USER_AGENT });

      t.after(async () => {

        await dispatcher.destroy();
      });

      const controller = new AbortController();
      const reason = deadlineReason();
      const pending = track(request(origin + "/refused", { dispatcher, signal: controller.signal }));

      await waitUntil(() => (dialFailures() === 1) && (consults.length === 1), { description: "the first dial to fail and its backoff to begin" });
      controller.abort(reason);

      assert.equal(await rejectionOf(pending, "the request to reject"), reason);

      await dispatcher.destroy();

      /* Released into the destroyed pool, the retry re-dispatches and the pool refuses it with its destroyed error and a null controller, which does not read
       * aborted, so the policy is consulted once more with that error. What the policy passes up finds the gate settled and is dropped.
       */
      expectAt(held, 0, "the held consult")();
      await settle();

      assert.deepEqual(consults, [ "ECONNREFUSED", "UND_ERR_DESTROYED" ]);
      assert.equal(dials(), 1);
    });
  });

  test("rejects a queued request aborted with a null reason with the transport's request-aborted error", async (t) => {

    const { dispatcher, server } = await startHeldRig(t);
    const first = track(request(server.origin + "/first", { dispatcher }));

    await waitUntil(() => server.exchanges.length === 1, { description: "the first request to reach the server" });

    const controller = new AbortController();
    const queued = track(request(server.origin + "/queued", { dispatcher, signal: controller.signal }));

    controller.abort(null);

    const failure = await rejectionOf(queued, "the queued request to reject");

    assert.ok(failure instanceof errors.RequestAbortedError);
    assert.equal(failure.code, "UND_ERR_ABORTED");

    expectAt(server.exchanges, 0, "the first exchange").response.end("first");
    await (await resolutionOf(first, "the first request to complete")).body.dump();
  });

  test("hands a raw caller queued behind a held request a falsy reason as the value itself", async (t) => {

    const { dispatcher, server } = await startHeldRig(t);
    const first = track(request(server.origin + "/first", { dispatcher }));

    await waitUntil(() => server.exchanges.length === 1, { description: "the first request to reach the server" });

    const controller = new AbortController();
    const recorder = recordingHandler();
    const options: SignalledOptions = { method: "GET", path: "/queued", signal: controller.signal };

    dispatcher.dispatch(options, recorder.handler);
    controller.abort(0);

    /* A reason gives way to the transport's own error only when it is null or undefined, so a falsy one reaches the caller as itself. A raw handler is what shows it:
     * the transport's request APIs settle their promises on the error's truthiness, so none of them can reject with a falsy value.
     */
    assert.deepEqual(recorder.calls, ["onResponseError"]);
    assert.equal(expectAt(recorder.failures, 0, "the error the caller was handed"), 0);

    expectAt(server.exchanges, 0, "the first exchange").response.end("first");
    await (await resolutionOf(first, "the first request to complete")).body.dump();
  });
});
