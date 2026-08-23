/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * api-dispatcher.test.ts: Unit tests for the API dispatcher factory - the pool and retry derivations with every default and override, the header stamp across every
 * shape a dispatch may carry its headers in, and the composed dispatcher exercised end to end against ephemeral servers.
 *
 * The derivations are asserted against written-out literals rather than against the module's own exported constants, because a comparison drawn from the same
 * declaration under test agrees with a typo in it. The wire phases exist for what no pure assertion can reach: whether the caller's retry policy actually arrives at
 * the interceptor, whether opting out really composes nothing, and how many times a request touched the network. Each phase owns its own server and its own counter,
 * so no phase can borrow another's evidence.
 */
import { API_RETRY_STATUS_CODES, apiPoolOptions, apiRetryOptions, createApiDispatcher, headerStampInterceptor } from "./api-dispatcher.ts";
import { describe, test } from "node:test";
import type { AddressInfo } from "node:net";
import type { Dispatcher } from "undici";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { expectAt } from "./testing/index.ts";
import { request } from "undici";

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

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

  return {

    agents,
    close: async (): Promise<void> => new Promise<void>((resolve) => server.close(() => resolve())),
    firstHit: firstHit.promise,
    hits: (): number => agents.length,

    // The listening callback above has already fired, so the address is the bound socket's. Same read the MQTT test helpers make.
    origin: "http://127.0.0.1:" + String((server.address() as AddressInfo).port)
  };
}

describe("the API pool derivation", () => {

  test("applies every default and adds no connect entry", () => {

    assert.deepEqual(apiPoolOptions(BASE_OPTIONS), { allowH2: true, clientTtl: 60000, connections: 1 });
  });

  test("relaxes the certificate check only when asked, and only then", () => {

    assert.deepEqual(apiPoolOptions({ ...BASE_OPTIONS, rejectUnauthorized: false }),
      { allowH2: true, clientTtl: 60000, connect: { rejectUnauthorized: false }, connections: 1 });

    assert.deepEqual(apiPoolOptions({ ...BASE_OPTIONS, rejectUnauthorized: true }), { allowH2: true, clientTtl: 60000, connections: 1 });
  });

  test("carries each construction option through verbatim", () => {

    assert.deepEqual(apiPoolOptions({ ...BASE_OPTIONS, allowH2: false }), { allowH2: false, clientTtl: 60000, connections: 1 });
    assert.deepEqual(apiPoolOptions({ ...BASE_OPTIONS, clientTtl: 120000 }), { allowH2: true, clientTtl: 120000, connections: 1 });
    assert.deepEqual(apiPoolOptions({ ...BASE_OPTIONS, connections: 2 }), { allowH2: true, clientTtl: 60000, connections: 2 });
  });

  test("keeps a null clientTtl, which asks for no recycling at all", () => {

    assert.deepEqual(apiPoolOptions({ ...BASE_OPTIONS, clientTtl: null }), { allowH2: true, clientTtl: null, connections: 1 });
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
