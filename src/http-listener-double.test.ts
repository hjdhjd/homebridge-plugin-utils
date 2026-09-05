/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * http-listener-double.test.ts: Unit tests for the socket-free HttpListener double - what it records, the matching a delivery meets, and the lifecycle it mirrors.
 *
 * This suite is the drift alarm. The double stands in for the real listener at a consumer's dependency boundary, so every arm below asserts a behavior the real
 * class's own suite asserts against a socket: the route refusals, the disposal by identity, the exact-route-before-catch-all order, and the 404 and 405 a delivery
 * meets. The shared type imports are the compile-time half of the same guard.
 */
import { HTTP_LISTENER_ANY_PATH } from "./http-listener.ts";
import { TestHttpListener } from "./http-listener-double.ts";
import assert from "node:assert/strict";
import { assertNoUnhandledRejections } from "./testing/index.ts";
import { isHbpuAbortReason } from "./util.ts";
import test from "node:test";

// One request to hand a handler. The double passes it through untouched, so its contents matter only where an arm reads them back.
const REQUEST = { body: Buffer.from("{}"), headers: {} };

test("a double is bound the moment it exists, and reports the port it was given until it ends", async () => {

  const listener = new TestHttpListener({ port: 10110 });

  // There is no kernel to wait on, so readiness is not something a consumer's test has to arrange.
  await listener.ready;

  assert.equal(listener.aborted, false);
  assert.equal(listener.boundPort, 10110);

  listener.abort();

  // Zero once the lifetime ends, which is what the real class reports once its server has closed.
  assert.equal(listener.boundPort, 0);
});

test("a double built over a lifetime that has already ended never comes up", async () => {

  await assertNoUnhandledRejections(async () => {

    const controller = new AbortController();

    controller.abort();

    const listener = new TestHttpListener({ port: 10110, signal: controller.signal });

    assert.equal(listener.aborted, true);
    assert.equal(listener.boundPort, 0);

    // The real class settles `ready` with the lifetime's reason rather than leaving it pending, and so does this one.
    await assert.rejects(listener.ready, (error: unknown) => error === controller.signal.reason);
    assert.throws(() => listener.route("/anything", () => ({ status: 200 })), (error: unknown) => error === controller.signal.reason);
  });
});

test("a registration is recorded with its handler and its options, and refuses a path already taken", () => {

  const listener = new TestHttpListener();
  const handler = (): { status: number } => ({ status: 200 });
  const handle = listener.route("/events", handler, { methods: ["POST"] });

  // The wiring view a consumer's test reads: which paths were claimed, by which handler, under which filter.
  assert.equal(listener.routes.size, 1);
  assert.equal(listener.routes.get("/events")?.handler, handler);
  assert.deepEqual(listener.routes.get("/events")?.methods, ["POST"]);

  assert.throws(() => listener.route("/events", handler), (error: unknown) => (error instanceof TypeError) && error.message.includes("/events"));

  handle[Symbol.dispose]();

  assert.equal(listener.routes.size, 0);

  // Disposal by identity, as the real class does: the stale handle names a path routed again, but not to the registration it made.
  const live = listener.route("/events", handler);

  handle[Symbol.dispose]();

  assert.equal(listener.routes.size, 1, "a stale handle must remove nothing rather than removing the live route");

  live[Symbol.dispose]();
});

test("a delivery meets the matching the real serve path applies", () => {

  const listener = new TestHttpListener();

  using _accept = listener.route("/accept", () => ({ body: "taken", status: 200 }), { methods: ["POST"] });
  using _boom = listener.route("/boom", () => { throw new Error("handler fell over"); });

  // A path nothing claims, with no catch-all to fall back to.
  assert.equal(listener.deliver("/nothing", REQUEST).status, 404);

  // A method the route's filter excludes, answered without the handler running.
  assert.equal(listener.deliver("/accept", REQUEST, "GET").status, 405);

  const answer = listener.deliver("/accept", REQUEST);

  assert.equal(answer.status, 200);
  assert.equal(answer.body, "taken");

  /* A handler that throws propagates out of the delivery rather than becoming the 500 the real class logs and writes, because a consumer's test wants its own fault
   * in hand rather than a status standing in for it. That translation belongs to the real class and its suite.
   */
  assert.throws(() => listener.deliver("/boom", REQUEST), (error: unknown) => (error instanceof Error) && (error.message === "handler fell over"));
});

test("an exact route takes precedence over a catch-all, which answers everything else", () => {

  const listener = new TestHttpListener();

  using _anywhere = listener.route(HTTP_LISTENER_ANY_PATH, () => ({ body: "catch-all", status: 200 }));
  using _exact = listener.route("/a", () => ({ body: "exact", status: 200 }));

  assert.equal(listener.deliver("/a", REQUEST).body, "exact");
  assert.equal(listener.deliver("/anything", REQUEST).body, "catch-all");
  assert.equal(listener.deliver("/", REQUEST, "GET").body, "catch-all");
});

test("a double that ends releases every route and disposes cleanly", async () => {

  const listener = new TestHttpListener({ port: 10110 });

  listener.route("/a", () => ({ status: 200 }));
  listener.route(HTTP_LISTENER_ANY_PATH, () => ({ status: 200 }));

  assert.equal(listener.routes.size, 2);

  await listener[Symbol.asyncDispose]();

  assert.equal(listener.aborted, true);
  assert.equal(listener.routes.size, 0, "teardown releases every consumer closure the double was holding");
  assert.equal(listener.deliver("/a", REQUEST).status, 404);
  assert.throws(() => listener.route("/a", () => ({ status: 200 })), (error: unknown) => isHbpuAbortReason(error, "shutdown"));
});
