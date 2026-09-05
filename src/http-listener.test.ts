/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * http-listener.test.ts: Unit tests for HttpListener - the route table and its matching order, the bounded body read, the clock-driven bind retry, and the lifecycle
 * a signal governs.
 *
 * Every arm drives a real server on an ephemeral port and speaks real HTTP to it. That is deliberate: what this module is for is the behavior of an actual socket - a
 * body arriving in pieces, a header sent twice, a connection that outlives its request, a port somebody else already holds - and none of that is exercised by calling
 * the handlers directly. The retry arms are the exception in one respect only: their waits run on a TestClock, so a schedule is asserted rather than waited out.
 */
import { HTTP_LISTENER_ANY_PATH, HttpListener } from "./http-listener.ts";
import { HbpuAbortError, isHbpuAbortReason } from "./util.ts";
import { assertNoUnhandledRejections, capturingLog, expectAt, logCount, loggedAt, settle, waitUntil } from "./testing/index.ts";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { TestClock } from "./clock-double.ts";
import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

// The label every arm constructs its listener with, so an assertion that a line names the listener has one string to look for.
const LABEL = "test listener";

// The retry interval the clock-driven arms use. Distinct from the module's own default so an assertion that the wait the listener asked for is this one cannot pass
// by coincidence.
const RETRY_MS = 250;

/* Hold a TCP port so a listener asked for it finds it taken. An arm that only needs the port held for its whole body writes `await using blocker = await
 * holdTcpPort()`; one that needs it freed mid-body disposes it by hand and lets the scope's own disposal find nothing left to close, which is a safe no-op.
 *
 * @returns The held port and the disposal that releases it.
 */
async function holdTcpPort(): Promise<AsyncDisposable & { port: number }> {

  const blocker = createServer();

  await new Promise<void>((resolve) => void blocker.listen(0, () => resolve()));

  const address = blocker.address();

  return {

    port: ((address === null) || (typeof address === "string")) ? 0 : address.port,

    async [Symbol.asyncDispose](): Promise<void> {

      await new Promise<void>((resolve) => void blocker.close(() => resolve()));
    }
  };
}

/* Whether `port` can be bound, in a SINGLE attempt with no retry window. The single attempt is the assertion: a correct disposal has released the port before it
 * resolves, so a probe that polled for a couple of seconds would let a release that arrives late pass as one that arrived on time.
 *
 * @param port - The port to try.
 *
 * @returns Whether the attempt bound it.
 */
async function bindable(port: number): Promise<boolean> {

  return new Promise<boolean>((resolve) => {

    const probe = createServer();

    probe.once("error", () => resolve(false));
    probe.listen(port, () => void probe.close(() => resolve(true)));
  });
}

/* One HTTP request against a listener under test.
 *
 * @param options - The request to make. The method defaults to POST, which is what most arms send.
 *
 * @returns The status, headers, and body the listener answered with.
 */
async function request(options: { body?: Buffer | string; headers?: Record<string, string | string[]>; method?: string; path: string;
  port: number; }): Promise<{ body: string; headers: IncomingHttpHeaders; status: number }> {

  return new Promise((resolve, reject) => {

    const call = httpRequest({ headers: options.headers, host: "127.0.0.1", method: options.method ?? "POST", path: options.path, port: options.port },
      (response) => {

        const chunks: Buffer[] = [];

        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({ body: Buffer.concat(chunks).toString("utf8"), headers: response.headers, status: response.statusCode ?? 0 }));
      });

    call.on("error", reject);
    call.end(options.body);
  });
}

/* Send one request over a raw socket and answer the status of the first response line the listener writes.
 *
 * A raw socket rather than the HTTP client, for the two arms whose request is refused before its body has been read. The client is then left owing a body nobody
 * consumed, and what it reports afterwards is the connection's own outcome - a reset, or the unread bytes parsed as a second request - rather than the answer the
 * listener wrote. Reading the first bytes off the wire asks nothing further of them.
 *
 * @param options - The request to send and where to send it.
 *
 * @returns The status from the first response line, or zero when nothing arrived before the deadline, which is what a listener that answered only after reading the
 *          whole body would leave.
 */
async function rawStatus(options: { body: Buffer; method: string; path: string; port: number }): Promise<number> {

  const socket = createConnection({ host: "127.0.0.1", port: options.port });

  try {

    const answered = new Promise<number>((resolve) => {

      socket.once("data", (chunk: Buffer) => resolve(Number((/^HTTP\/1\.\d (\d{3})/.exec(chunk.toString("utf8")))?.[1] ?? 0)));
    });

    socket.on("error", () => { /* A listener that drops the connection after answering is one of the outcomes this helper exists to read past. */ });

    socket.write(options.method + " " + options.path + " HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: " + options.body.length.toString() + "\r\n\r\n");
    socket.write(options.body);

    return await Promise.race([ answered, delay(2000, 0, { ref: false }) ]);
  } finally {

    socket.destroy();
  }
}

/* Open a request that sends its headers and part of a body and never ends it, so the server is holding it open when the arm's real subject runs. The second,
 * complete request is the proof the server has read this one's headers: it was sent after them, so an answer to it cannot precede them.
 *
 * @param options - The path to open, the ping path to prove arrival with, and the port.
 *
 * @returns The open request, for the arm to reset or abandon.
 */
async function openStalledUpload(options: { path: string; pingPath: string; port: number }): Promise<ReturnType<typeof httpRequest>> {

  const call = httpRequest({ headers: { "content-length": "4096" }, host: "127.0.0.1", method: "POST", path: options.path, port: options.port });

  call.on("error", () => { /* The arm ends this request by resetting it or by tearing the server down, and both surface here. */ });

  await new Promise<void>((resolve) => void call.write(Buffer.alloc(16, 0x61), () => resolve()));

  assert.equal((await request({ body: "{}", path: options.pingPath, port: options.port })).status, 200, "the server must have read the stalled request's headers");

  return call;
}

test("the listener announces the port it bound and says nothing else", async () => {

  const log = capturingLog();

  await using listener = new HttpListener({ label: LABEL, log, port: 0 });

  await listener.ready;

  assert.ok(listener.boundPort > 0, "an ephemeral port must resolve to a real one");
  assert.equal(log.entries.length, 1, "a listener that came up cleanly has exactly one thing to say");
  assert.equal(expectAt(log.entries, 0).level, "info");
  assert.ok(loggedAt(log.entries, "info", LABEL), "the line must name the listener by its label");
  assert.ok(loggedAt(log.entries, "info", listener.boundPort.toString()), "the line must name the port the kernel gave, not the one that was asked for");
});

test("the listener answers each kind of request with the status that describes it", async () => {

  const log = capturingLog();

  await using listener = new HttpListener({ label: LABEL, log, port: 0 });

  await listener.ready;

  const port = listener.boundPort;
  const accepted = listener.route("/accept", () => ({ status: 200 }), { methods: ["POST"] });
  const refused = listener.route("/refuse", () => ({ status: 401 }), { methods: ["POST"] });
  const faulty = listener.route("/fault", () => { throw new Error("handler fell over"); }, { methods: ["POST"] });

  // A method outside the route's list is refused without a body ever being read.
  assert.equal((await request({ method: "GET", path: "/accept", port })).status, 405);

  // A path nothing routes is nobody's request.
  assert.equal((await request({ body: "{}", path: "/nothing", port })).status, 404);

  // The path decides whether a resource exists and the method is a property of the route, so an unrouted GET is a 404 rather than the 405 a method-first order
  // would answer with.
  assert.equal((await request({ method: "GET", path: "/nothing", port })).status, 404);

  // The handler's verdict is the answer, whichever it is.
  assert.equal((await request({ body: "{}", path: "/accept", port })).status, 200);
  assert.equal((await request({ body: "{}", path: "/refuse", port })).status, 401);

  /* A fault inside one handler is reported as a failure rather than as a refusal, because those mean different things to whatever is retrying on the other end. It
   * is reported once, naming the listener, the route, and the throw's own message.
   */
  assert.equal((await request({ body: "{}", path: "/fault", port })).status, 500);
  assert.equal(logCount(log.entries, "error", "handler fell over"), 1, "the fault must be reported exactly once");
  assert.ok(loggedAt(log.entries, "error", LABEL));
  assert.ok(loggedAt(log.entries, "error", "/fault"));

  // The query string never takes part in matching, so a sender that appends something of its own still reaches the route it addressed.
  assert.equal((await request({ body: "{}", path: "/accept?x=1", port })).status, 200);

  for(const handle of [ accepted, faulty, refused ]) {

    handle[Symbol.dispose]();
  }

  // A disposed route is gone, so the path it held answers as unrouted again.
  assert.equal((await request({ body: "{}", path: "/accept", port })).status, 404);
});

test("a body past the limit is refused and never reaches the handler, and a body exactly at it is admitted", async () => {

  const limit = 1024;
  const log = capturingLog();

  await using listener = new HttpListener({ bodyLimit: limit, label: LABEL, log, port: 0 });

  await listener.ready;

  const port = listener.boundPort;
  let reached = 0;

  using _route = listener.route("/big", () => {

    reached++;

    return { status: 200 };
  });

  assert.equal(await rawStatus({ body: Buffer.alloc(limit + 4096, 0x61), method: "POST", path: "/big", port }), 413, "an oversized body is refused rather than accepted");
  assert.equal(reached, 0, "a body past the limit must never reach the handler");

  // A body of exactly the limit is admitted. The refusal is for a body that crosses the limit, not for one that reaches it.
  assert.equal((await request({ body: Buffer.alloc(limit, 0x62), path: "/big", port })).status, 200);
  assert.equal(reached, 1);
});

test("the body reaches the handler exactly as it arrived", async () => {

  const log = capturingLog();

  await using listener = new HttpListener({ label: LABEL, log, port: 0 });

  await listener.ready;

  const raw = "{\n  \"event\":\"door.unlock\",   \"data\":{ \"z\":1, \"a\":2 }\n}";
  let seen: Buffer | undefined;

  using _route = listener.route("/raw", (delivery) => {

    seen = delivery.body;

    return { status: 200 };
  });

  assert.equal((await request({ body: raw, path: "/raw", port: listener.boundPort })).status, 200);

  /* The buffers are compared rather than the parsed values. Irregular whitespace and key order are exactly what a parse and re-encode would tidy away, and exactly
   * what a signature computed over the raw bytes covers, so a listener that tidied the body would turn every authentic delivery into a refusal.
   */
  assert.deepEqual(seen, Buffer.from(raw, "utf8"));
});

test("headers reach the handler as Node parsed them", async () => {

  const log = capturingLog();

  await using listener = new HttpListener({ label: LABEL, log, port: 0 });

  await listener.ready;

  const port = listener.boundPort;
  const seen: IncomingHttpHeaders[] = [];

  using _route = listener.route("/header", (delivery) => {

    seen.push(delivery.headers);

    return { status: 200 };
  });

  await request({ body: "{}", headers: { "X-Plugin-Token": "one" }, path: "/header", port });
  await request({ body: "{}", headers: { "X-Plugin-Token": [ "one", "two" ] }, path: "/header", port });

  assert.equal(expectAt(seen, 0)["x-plugin-token"], "one", "a header the sender set must reach the handler by name");
  assert.equal(expectAt(seen, 0)["x-absent-header"], undefined, "a header nobody sent must read as nothing at all");

  /* Node joins repeats of an ordinary header into one value, and what the handler gets is whatever Node produced. The passthrough is the contract being asserted:
   * a header layer of the listener's own, applying its own rule about repeats, could not slip in under this.
   */
  const repeated = expectAt(seen, 1)["x-plugin-token"];

  assert.equal(typeof repeated, "string", "a repeated ordinary header arrives joined rather than as an array");
  assert.ok((typeof repeated === "string") && repeated.includes("one") && repeated.includes("two"));
});

test("disposal completes under an in-flight request and releases the port at once", async () => {

  await assertNoUnhandledRejections(async () => {

    const log = capturingLog();
    const listener = new HttpListener({ label: LABEL, log, port: 0 });

    await listener.ready;

    const port = listener.boundPort;

    using _ping = listener.route("/ping", () => ({ status: 200 }));
    using _upload = listener.route("/upload", () => ({ status: 200 }));

    const stalled = await openStalledUpload({ path: "/upload", pingPath: "/ping", port });

    /* A client holding a request open is exactly what would keep a server from finishing its close. Dropping the connections is what makes disposal complete anyway,
     * so the race below is against a real deadline rather than against nothing.
     */
    const outcome = await Promise.race([ listener[Symbol.asyncDispose]().then(() => "disposed"), delay(2000, "timed out", { ref: false }) ]);

    assert.equal(outcome, "disposed", "disposal must not wait on an in-flight request");
    assert.equal(await bindable(port), true, "the port must be bindable on the first attempt once disposal resolves");

    stalled.destroy();
  });
});

test("a teardown under an in-flight upload says nothing beyond the listening line", async () => {

  const log = capturingLog();
  const listener = new HttpListener({ label: LABEL, log, port: 0 });

  await listener.ready;

  const port = listener.boundPort;

  using _ping = listener.route("/ping", () => ({ status: 200 }));
  using _upload = listener.route("/upload", () => ({ status: 200 }));

  const stalled = await openStalledUpload({ path: "/upload", pingPath: "/ping", port });

  await listener[Symbol.asyncDispose]();
  await settle(2);

  // The teardown destroys the socket under the body read, which is the listener's own doing rather than news. A line here would be the listener narrating its own
  // shutdown once per connection it dropped.
  assert.equal(log.entries.length, 1, "a teardown that drops a connection mid-upload has nothing to report");

  stalled.destroy();
});

test("a route is refused on a path already taken, and the refusal names the collision", async () => {

  const log = capturingLog();

  await using listener = new HttpListener({ label: LABEL, log, port: 0 });

  await listener.ready;

  const handle = listener.route("/taken", () => ({ status: 200 }));

  // Two consumers configured against one path would collide here. The message is the catcher's mechanism, so it names which path refused.
  assert.throws(() => listener.route("/taken", () => ({ status: 200 })),
    (error: unknown) => (error instanceof TypeError) && error.message.includes("already routes") && error.message.includes("/taken"));

  handle[Symbol.dispose]();

  // Once the path is released it routes again, so the refusal was about the collision rather than about the path itself.
  listener.route("/taken", () => ({ status: 200 }))[Symbol.dispose]();
});

test("a listener whose lifetime has ended accepts no route", async () => {

  const log = capturingLog();
  const listener = new HttpListener({ label: LABEL, log, port: 0 });

  await listener.ready;
  await listener[Symbol.asyncDispose]();

  assert.equal(listener.aborted, true);

  /* The refusal is the lifetime's own reason rather than a shape of the listener's invention, so a consumer configuring itself against a listener that has already
   * gone away learns why it is gone from the throw.
   */
  assert.throws(() => listener.route("/anything", () => ({ status: 200 })), (error: unknown) => isHbpuAbortReason(error, "shutdown"));
});

test("a bind failure that is not a port conflict ends the listener and reports itself once", async (t) => {

  const log = capturingLog();

  /* Binding a privileged port is refused for an ordinary user on most platforms, and that refusal is a server error rather than a port conflict, so it takes the
   * fatal arm rather than the retry arm. A platform that lets an ordinary user bind one has nothing here to observe, so this arm skips with its reason recorded
   * rather than asserting something untrue.
   */
  const listener = new HttpListener({ label: LABEL, log, port: 1 });

  t.after(() => listener.abort());

  const outcome: unknown = await listener.ready.then(() => "bound").catch((error: unknown) => error);

  if(outcome === "bound") {

    t.skip("this platform lets an ordinary user bind a privileged port, so the refusal this arm needs does not happen here");

    return;
  }

  assert.ok(isHbpuAbortReason(outcome, "failed"), "a fatal bind failure ends the lifetime as a failure, carrying the kernel's error");
  assert.equal(listener.aborted, true);
  assert.equal(logCount(log.entries, "error", "could not start"), 1, "the fault must be reported exactly once");
  assert.ok(loggedAt(log.entries, "error", LABEL));
});

test("a lifetime that ends before the retry fires cancels it, and the port is never bound", async () => {

  await assertNoUnhandledRejections(async () => {

    await using blocker = await holdTcpPort();

    const clock = new TestClock();
    const log = capturingLog();
    const listener = new HttpListener({ clock, label: LABEL, log, port: blocker.port, retryMs: RETRY_MS });

    await waitUntil(() => clock.pending === 1, { description: "the retry wait to be armed" });

    assert.equal(logCount(log.entries, "error", "in use"), 1, "the conflict must be reported");
    assert.ok(loggedAt(log.entries, "error", LABEL));

    listener.abort();

    assert.equal(clock.pending, 0, "a lifetime that ends cancels the wait rather than leaving it armed");

    // A retry that re-listened regardless would take the port the moment it frees, which is the failure this arm exists to catch.
    await blocker[Symbol.asyncDispose]();
    clock.advance(RETRY_MS);
    await settle();

    assert.equal(listener.boundPort, 0, "a listener whose lifetime ended must never bind, however free the port becomes");
    assert.equal(logCount(log.entries, "error", "in use"), 1);

    await listener[Symbol.asyncDispose]();
  });
});

test("an abort landing in the same turn the retry wait ends still binds nothing", async () => {

  await assertNoUnhandledRejections(async () => {

    await using blocker = await holdTcpPort();

    const clock = new TestClock();
    const log = capturingLog();
    const listener = new HttpListener({ clock, label: LABEL, log, port: blocker.port, retryMs: RETRY_MS });

    await waitUntil(() => clock.pending === 1, { description: "the retry wait to be armed" });

    /* The port frees, the wait ends, and the lifetime ends before anything yields. The attempt that the wait released has not run yet, and it must find the lifetime
     * over rather than binding a server the teardown has already closed - which is the one window a signal check made only before the retry loop leaves open.
     */
    await blocker[Symbol.asyncDispose]();
    clock.advance(RETRY_MS);
    listener.abort();

    await settle(2);

    assert.equal(listener.boundPort, 0, "the attempt released by the ended wait must not bind");
    assert.equal(await bindable(blocker.port), true, "the port must be free, which it is not if the listener took it after the abort");

    await listener[Symbol.asyncDispose]();
  });
});

test("a port that frees up is bound on the retry, and the wait was the configured one", async () => {

  const blocker = await holdTcpPort();
  const clock = new TestClock();
  const log = capturingLog();

  await using listener = new HttpListener({ clock, label: LABEL, log, port: blocker.port, retryMs: RETRY_MS });

  await waitUntil(() => clock.pending === 1, { description: "the retry wait to be armed" });

  await blocker[Symbol.asyncDispose]();
  clock.advance(RETRY_MS);

  await listener.ready;

  assert.equal(listener.boundPort, blocker.port, "the retry must bind the port once it frees");

  // The wait ran on the injected clock, which is what a raw timer in place of the library's retry could not satisfy.
  assert.ok(clock.requested.includes(RETRY_MS), "the backoff the listener asked for must be the configured interval");
});

test("a port held through several intervals is waited out rather than given up on", async () => {

  const blocker = await holdTcpPort();
  const clock = new TestClock();
  const log = capturingLog();

  await using listener = new HttpListener({ clock, label: LABEL, log, port: blocker.port, retryMs: RETRY_MS });

  // Every failed attempt reports and arms the next. A listener that armed one retry and then gave up would report the conflict once and never come up at all.
  await waitUntil(() => clock.pending === 1, { description: "the first retry wait to be armed" });
  clock.advance(RETRY_MS);

  await waitUntil(() => (logCount(log.entries, "error", "in use") === 2) && (clock.pending === 1), { description: "the second conflict and its wait" });
  clock.advance(RETRY_MS);

  await waitUntil(() => (logCount(log.entries, "error", "in use") === 3) && (clock.pending === 1), { description: "the third conflict and its wait" });

  await blocker[Symbol.asyncDispose]();
  clock.advance(RETRY_MS);

  await listener.ready;

  assert.equal(listener.boundPort, blocker.port, "the listener must still come up after several conflicts");
});

test("a listener constructed over a lifetime that has already ended never binds", async () => {

  await assertNoUnhandledRejections(async () => {

    const controller = new AbortController();
    const log = capturingLog();

    controller.abort(new HbpuAbortError("shutdown"));

    const listener = new HttpListener({ label: LABEL, log, port: 0, signal: controller.signal });

    assert.equal(listener.aborted, true);
    assert.equal(listener.boundPort, 0, "a listener that never called listen has no port to report");
    assert.equal(log.entries.length, 0, "a listener that never bound announces nothing");

    // `ready` settles rather than hanging, and it settles with the reason the lifetime ended for.
    await assert.rejects(listener.ready, (error: unknown) => error === listener.signal.reason);

    await listener[Symbol.asyncDispose]();
  });
});

test("the method filter answers before the body is read", async () => {

  const limit = 1024;
  const log = capturingLog();

  await using listener = new HttpListener({ bodyLimit: limit, label: LABEL, log, port: 0 });

  await listener.ready;

  let reached = 0;

  using _route = listener.route("/post-only", () => {

    reached++;

    return { status: 200 };
  }, { methods: ["POST"] });

  /* A GET carrying more than the body limit. The method refusal must answer it rather than the size refusal, because a route that would never have been handed the
   * body has no business paying to read it. A listener that read first would answer 413 here, and one that read first and then never finished would answer nothing
   * at all before the deadline.
   */
  assert.equal(await rawStatus({ body: Buffer.alloc(limit + 4096, 0x61), method: "GET", path: "/post-only", port: listener.boundPort }), 405,
    "the method is refused, not the size");
  assert.equal(reached, 0);
});

test("the handler's status, headers, and body are what the client reads", async () => {

  const log = capturingLog();

  await using listener = new HttpListener({ label: LABEL, log, port: 0 });

  await listener.ready;

  const playlist = "#EXTM3U\n#EXTINF:-1,Front Door\n";

  using _route = listener.route("/playlist", () => ({ body: playlist, headers: { "Content-Type": "application/x-mpegURL" }, status: 200 }));

  const answer = await request({ method: "GET", path: "/playlist", port: listener.boundPort });

  assert.equal(answer.status, 200);
  assert.equal(answer.headers["content-type"], "application/x-mpegURL");
  assert.equal(answer.body, playlist);
});

test("an await using scope has released the port by its next statement", async () => {

  await assertNoUnhandledRejections(async () => {

    const log = capturingLog();
    let port = 0;

    {

      await using listener = new HttpListener({ label: LABEL, log, port: 0 });

      await listener.ready;
      port = listener.boundPort;
    }

    assert.ok(port > 0);
    assert.equal(await bindable(port), true, "the port must be bindable on the first attempt once the scope has exited");
  });
});

test("a client that resets mid-body produces no response and no log line", async () => {

  const log = capturingLog();

  await using listener = new HttpListener({ label: LABEL, log, port: 0 });

  await listener.ready;

  const port = listener.boundPort;

  using _ping = listener.route("/ping", () => ({ status: 200 }));
  using _upload = listener.route("/upload", () => ({ status: 200 }));

  const stalled = await openStalledUpload({ path: "/upload", pingPath: "/ping", port });

  stalled.destroy();

  /* A full request round trip after the reset gives the listener every chance to have said something about it, and proves the reset ended that request rather than
   * the listener. The peer is untrusted: anything it can cause at will must not be able to write into the log at will.
   */
  assert.equal((await request({ body: "{}", path: "/ping", port })).status, 200);
  assert.equal(log.entries.length, 1, "a client reset is the client's business and none of the log's");
});

test("a route handle disposed after its path was claimed again removes nothing", async () => {

  const log = capturingLog();

  await using listener = new HttpListener({ label: LABEL, log, port: 0 });

  await listener.ready;

  const port = listener.boundPort;
  const stale = listener.route("/shared", () => ({ status: 418 }));

  stale[Symbol.dispose]();

  using _live = listener.route("/shared", () => ({ status: 200 }));

  // The stale handle names a path that is routed again, but not to the registration it made. Disposing by key rather than by identity would remove somebody else's
  // live route here, which is a fault the holder of the stale handle can neither see nor intend.
  stale[Symbol.dispose]();

  assert.equal((await request({ body: "{}", path: "/shared", port })).status, 200, "the live route must survive a stale handle's disposal");
});

test("a catch-all route answers every path no exact route claims", async () => {

  const log = capturingLog();

  await using listener = new HttpListener({ label: LABEL, log, port: 0 });

  await listener.ready;

  const port = listener.boundPort;
  const anywhere = listener.route(HTTP_LISTENER_ANY_PATH, () => ({ body: "catch-all", status: 200 }));

  // A route with no method filter accepts every method, which is what a publisher answering whatever a player asks for needs.
  assert.equal((await request({ body: "{}", path: "/anything", port })).body, "catch-all");
  assert.equal((await request({ method: "GET", path: "/", port })).body, "catch-all");

  using _exact = listener.route("/a", () => ({ body: "exact", status: 200 }));

  assert.equal((await request({ body: "{}", path: "/a", port })).body, "exact", "an exact route takes precedence over one claiming everything");

  // The catch-all is one route like any other, so claiming it twice collides like any other path, and the refusal says which claim collided.
  assert.throws(() => listener.route(HTTP_LISTENER_ANY_PATH, () => ({ status: 200 })),
    (error: unknown) => (error instanceof TypeError) && error.message.includes("every path"));

  anywhere[Symbol.dispose]();

  assert.equal((await request({ body: "{}", path: "/anything", port })).status, 404, "a released catch-all leaves the paths it answered unrouted");
});

test("an option that cannot produce a working listener is refused at construction, by name", () => {

  const log = capturingLog();

  // Each refusal names the option, so a misconfiguration is diagnosable where it was made rather than as an unexplained failure later.
  assert.throws(() => new HttpListener({ label: LABEL, log, port: 0, retryMs: 0 }),
    (error: unknown) => (error instanceof TypeError) && error.message.includes("retryMs"));
  assert.throws(() => new HttpListener({ bodyLimit: -1, label: LABEL, log, port: 0 }),
    (error: unknown) => (error instanceof TypeError) && error.message.includes("bodyLimit"));
  assert.throws(() => new HttpListener({ label: LABEL, log, port: 70000 }), (error: unknown) => (error instanceof TypeError) && error.message.includes("port"));
  assert.throws(() => new HttpListener({ label: LABEL, log, port: 1.5 }), (error: unknown) => (error instanceof TypeError) && error.message.includes("port"));
  assert.throws(() => new HttpListener({ label: "", log, port: 0 }), (error: unknown) => (error instanceof TypeError) && error.message.includes("label"));
});
