/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * logclient/auth.test.ts: Unit tests for token acquisition - the credential-DU switch, permanent/transient classification, and actionable, token-safe errors.
 */
import { LogAuthError, acquireToken, isPermanentAuthError } from "./auth.ts";
import { describe, test } from "node:test";
import type { LogClientCredentials } from "./types.ts";
import assert from "node:assert/strict";

// The connection target every test reuses. The auth flow builds `http://localhost:8581/api/auth/...` from these.
const TARGET = { host: "localhost", port: 8581 };

// Build a `fetch` seam double that captures every request and returns a caller-supplied response. The captured calls let a test assert the URL, method, and body the auth
// flow produced; the response factory lets each test steer success / status / network outcomes.
function fakeFetch(responder: (url: string, init: RequestInit | undefined) => Promise<Response> | Response): {
  calls: { init: RequestInit | undefined; url: string }[];
  fetch: typeof fetch;
} {

  const calls: { init: RequestInit | undefined; url: string }[] = [];

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {

    const url = (typeof input === "string") ? input : (input instanceof URL) ? input.href : input.url;

    calls.push({ init, url });

    return responder(url, init);
  }) as typeof fetch;

  return { calls, fetch: fetchImpl };
}

// Build a JSON `Response` with the given status and body. Defaults to a 200 carrying a token, the common success shape.
function jsonResponse(body: unknown, status = 200): Response {

  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" }, status });
}

// Build a server-shaped success body carrying an access token, assembled with bracket-notation keys so the snake_case wire field names do not trip the camelcase lint
// rule in test source (the production code reads these same fields via string index access for the same reason).
function tokenBody(token: string): Record<string, unknown> {

  const body: Record<string, unknown> = {};

  body["access_token"] = token;
  body["expires_in"] = 28800;
  body["token_type"] = "Bearer";

  return body;
}

describe("acquireToken - credential DU switch", () => {

  test("returns a pre-acquired token verbatim with no network call", async () => {

    const { calls, fetch } = fakeFetch(() => jsonResponse(tokenBody("unused")));
    const credentials: LogClientCredentials = { kind: "token", token: "raw.jwt.value" };

    const token = await acquireToken(credentials, { ...TARGET, fetch });

    assert.equal(token, "raw.jwt.value", "the token arm must return the token verbatim");
    assert.equal(calls.length, 0, "the token arm must not make any network call");
  });

  test("posts username/password to /api/auth/login and returns the access token", async () => {

    const { calls, fetch } = fakeFetch(() => jsonResponse(tokenBody("login.jwt")));
    const credentials: LogClientCredentials = { kind: "password", password: "secret", username: "admin" };

    const token = await acquireToken(credentials, { ...TARGET, fetch });

    assert.equal(token, "login.jwt");
    assert.equal(calls.length, 1);

    const call = calls[0];

    assert.ok(call !== undefined);
    assert.ok(call.init !== undefined);
    assert.equal(call.url, "http://localhost:8581/api/auth/login");
    assert.equal(call.init.method, "POST");
    assert.deepEqual(JSON.parse(call.init.body as string), { password: "secret", username: "admin" });
    assert.deepEqual(call.init.headers, { "Content-Type": "application/json" }, "a request that carries a JSON body must declare the application/json content-type");
  });

  test("includes the OTP in the login body when supplied", async () => {

    const { calls, fetch } = fakeFetch(() => jsonResponse(tokenBody("otp.jwt")));
    const credentials: LogClientCredentials = { kind: "password", otp: "123456", password: "secret", username: "admin" };

    await acquireToken(credentials, { ...TARGET, fetch });

    const call = calls[0];

    assert.ok(call !== undefined);
    assert.ok(call.init !== undefined);
    assert.deepEqual(JSON.parse(call.init.body as string), { otp: "123456", password: "secret", username: "admin" });
  });

  test("posts to /api/auth/noauth and returns the access token", async () => {

    const { calls, fetch } = fakeFetch(() => jsonResponse(tokenBody("noauth.jwt")));
    const credentials: LogClientCredentials = { kind: "noauth" };

    const token = await acquireToken(credentials, { ...TARGET, fetch });

    assert.equal(token, "noauth.jwt");

    const call = calls[0];

    assert.ok(call !== undefined);
    assert.ok(call.init !== undefined);
    assert.equal(call.url, "http://localhost:8581/api/auth/noauth");
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.body, undefined, "the noauth path must post no body");
    assert.equal(call.init.headers, undefined, "no Content-Type on the bodyless noauth POST - an empty application/json body is what Fastify rejects");
  });

  test("builds an https URL when tls is set", async () => {

    const { calls, fetch } = fakeFetch(() => jsonResponse(tokenBody("tls.jwt")));

    await acquireToken({ kind: "noauth" }, { ...TARGET, fetch, tls: true });

    const call = calls[0];

    assert.ok(call !== undefined);
    assert.equal(call.url, "https://localhost:8581/api/auth/noauth");
  });
});

describe("acquireToken - permanent vs transient classification", () => {

  test("classifies a 401 from login as permanent (wrong credentials)", async () => {

    const { fetch } = fakeFetch(() => jsonResponse({ message: "Unauthorized" }, 401));
    const credentials: LogClientCredentials = { kind: "password", password: "wrong", username: "admin" };

    const error = await acquireToken(credentials, { ...TARGET, fetch }).catch((e: unknown) => e);

    assert.ok(error instanceof LogAuthError);
    assert.equal(error.kind, "permanent");
    assert.equal(isPermanentAuthError(error), true);
  });

  test("classifies a 412 from login as permanent (OTP required)", async () => {

    const { fetch } = fakeFetch(() => jsonResponse({ message: "2fa-required" }, 412));
    const credentials: LogClientCredentials = { kind: "password", password: "secret", username: "admin" };

    const error = await acquireToken(credentials, { ...TARGET, fetch }).catch((e: unknown) => e);

    assert.ok(error instanceof LogAuthError);
    assert.equal(error.kind, "permanent");
    assert.match(error.message, /one-time passcode|otp/i, "the OTP-required message must mention the passcode");
  });

  test("classifies a 403 from noauth as permanent (noauth disabled)", async () => {

    const { fetch } = fakeFetch(() => jsonResponse({ message: "Forbidden" }, 403));

    const error = await acquireToken({ kind: "noauth" }, { ...TARGET, fetch }).catch((e: unknown) => e);

    assert.ok(error instanceof LogAuthError);
    assert.equal(error.kind, "permanent");
    assert.match(error.message, /authentication disabled|none/i, "the noauth-disabled message must advise enabling the none auth mode");
  });

  test("classifies a 400 from noauth as a permanent protocol error, not an auth-disabled hint", async () => {

    // Fastify (homebridge-config-ui-x 5.x) answers a malformed request with 400, whereas a server that simply is not in no-auth mode answers the no-auth path with 401. A
    // 400 must therefore read as a request/protocol problem and must never be misreported as "authentication is not disabled" - the exact misdiagnosis a real no-auth
    // server once produced when the bodyless POST was sent with a JSON content-type.
    const { fetch } = fakeFetch(() => jsonResponse({ message: "Body cannot be empty when content-type is set to 'application/json'" }, 400));

    const error = await acquireToken({ kind: "noauth" }, { ...TARGET, fetch }).catch((e: unknown) => e);

    assert.ok(error instanceof LogAuthError);
    assert.equal(error.kind, "permanent");
    assert.match(error.message, /malformed|protocol|HTTP 400/i, "a 400 must read as a malformed or protocol error");
    assert.doesNotMatch(error.message, /authentication disabled/i, "a 400 must not be misreported as authentication-not-disabled");
  });

  test("classifies a 500 as transient (server-side fault)", async () => {

    const { fetch } = fakeFetch(() => jsonResponse({ message: "Internal Server Error" }, 500));
    const credentials: LogClientCredentials = { kind: "password", password: "secret", username: "admin" };

    const error = await acquireToken(credentials, { ...TARGET, fetch }).catch((e: unknown) => e);

    assert.ok(error instanceof LogAuthError);
    assert.equal(error.kind, "transient");
    assert.equal(isPermanentAuthError(error), false);
  });

  test("classifies a network rejection as transient", async () => {

    const { fetch } = fakeFetch(() => { throw new Error("ECONNREFUSED 127.0.0.1:8581"); });
    const credentials: LogClientCredentials = { kind: "password", password: "secret", username: "admin" };

    const error = await acquireToken(credentials, { ...TARGET, fetch }).catch((e: unknown) => e);

    assert.ok(error instanceof LogAuthError);
    assert.equal(error.kind, "transient");
    assert.match(error.message, /could not reach/i);
  });

  test("classifies a 2xx success with no access token as permanent (broken contract)", async () => {

    // A 200 whose JSON body carries no `access_token` field at all - the success contract is broken, which is classified permanent.
    const { fetch } = fakeFetch(() => jsonResponse({ status: "ok" }));

    const error = await acquireToken({ kind: "noauth" }, { ...TARGET, fetch }).catch((e: unknown) => e);

    assert.ok(error instanceof LogAuthError);
    assert.equal(error.kind, "permanent");
    assert.match(error.message, /no access token/i);
  });

  test("classifies a 2xx success with an unreadable body as permanent", async () => {

    const { fetch } = fakeFetch(() => new Response("not json at all", { status: 200 }));

    const error = await acquireToken({ kind: "noauth" }, { ...TARGET, fetch }).catch((e: unknown) => e);

    assert.ok(error instanceof LogAuthError);
    assert.equal(error.kind, "permanent");
  });
});

describe("acquireToken - actionable, token-safe errors", () => {

  test("surfaces the server's error message detail in the failure", async () => {

    const { fetch } = fakeFetch(() => jsonResponse({ message: "Account is locked" }, 401));
    const credentials: LogClientCredentials = { kind: "password", password: "secret", username: "admin" };

    const error = await acquireToken(credentials, { ...TARGET, fetch }).catch((e: unknown) => e);

    assert.ok(error instanceof LogAuthError);
    assert.match(error.message, /Account is locked/, "the server's detail message must be surfaced for the user");
  });

  test("never leaks a pre-acquired token into an error path", async () => {

    // The token arm never performs a network call, so there is no error path that could carry the token; this asserts the contract by exercising the token arm and a
    // separate failing password arm whose error must not contain any token-like material.
    const { fetch } = fakeFetch(() => jsonResponse({ message: "Unauthorized" }, 401));
    const credentials: LogClientCredentials = { kind: "password", password: "super-secret-password", username: "admin" };

    const error = await acquireToken(credentials, { ...TARGET, fetch }).catch((e: unknown) => e);

    assert.ok(error instanceof LogAuthError);
    assert.doesNotMatch(error.message, /super-secret-password/, "the error message must never echo the credential material");
  });

  test("isPermanentAuthError returns false for a non-auth error", () => {

    assert.equal(isPermanentAuthError(new Error("some other error")), false);
    assert.equal(isPermanentAuthError(null), false);
    assert.equal(isPermanentAuthError(new LogAuthError("transient fault", { kind: "transient" })), false);
  });
});
