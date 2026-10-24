/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * logclient/auth.test.ts: Unit tests for token acquisition - the credential-DU switch, failure classification, actionable, token-safe errors, and cancellation.
 */
import { LogAuthError, acquireToken, isPermanentAuthError } from "./auth.ts";
import { describe, test } from "node:test";
import { recordingFetch, tokenBody } from "./rest.helpers.ts";
import { settle, waitUntil } from "../testing/index.ts";
import type { LogClientCredentials } from "./types.ts";
import assert from "node:assert/strict";
import { formatErrorMessage } from "../util.ts";
import { inspect } from "node:util";

// The connection target every test reuses. The auth flow builds `http://localhost:8581/api/auth/...` from these.
const TARGET = { host: "localhost", port: 8581 };

// Build a JSON `Response` with the given status and body. Defaults to a 200 carrying a token, the common success shape.
function jsonResponse(body: unknown, status = 200): Response {

  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" }, status });
}

describe("acquireToken - credential DU switch", () => {

  test("returns a pre-acquired token verbatim with no network call", async () => {

    const { calls, fetch } = recordingFetch(() => jsonResponse(tokenBody("unused")));
    const credentials: LogClientCredentials = { kind: "token", token: "raw.jwt.value" };

    const token = await acquireToken(credentials, { ...TARGET, fetch });

    assert.equal(token, "raw.jwt.value", "the token arm must return the token verbatim");
    assert.equal(calls.length, 0, "the token arm must not make any network call");
  });

  test("posts username/password to /api/auth/login and returns the access token", async () => {

    const { calls, fetch } = recordingFetch(() => jsonResponse(tokenBody("login.jwt")));
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

    const { calls, fetch } = recordingFetch(() => jsonResponse(tokenBody("otp.jwt")));
    const credentials: LogClientCredentials = { kind: "password", otp: "123456", password: "secret", username: "admin" };

    await acquireToken(credentials, { ...TARGET, fetch });

    const call = calls[0];

    assert.ok(call !== undefined);
    assert.ok(call.init !== undefined);
    assert.deepEqual(JSON.parse(call.init.body as string), { otp: "123456", password: "secret", username: "admin" });
  });

  test("posts to /api/auth/noauth and returns the access token", async () => {

    const { calls, fetch } = recordingFetch(() => jsonResponse(tokenBody("noauth.jwt")));
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

    const { calls, fetch } = recordingFetch(() => jsonResponse(tokenBody("tls.jwt")));

    await acquireToken({ kind: "noauth" }, { ...TARGET, fetch, tls: true });

    const call = calls[0];

    assert.ok(call !== undefined);
    assert.equal(call.url, "https://localhost:8581/api/auth/noauth");
  });
});

describe("acquireToken - permanent vs transient classification", () => {

  test("classifies a 401 from login as permanent (wrong credentials)", async () => {

    const { fetch } = recordingFetch(() => jsonResponse({ message: "Unauthorized" }, 401));
    const credentials: LogClientCredentials = { kind: "password", password: "wrong", username: "admin" };

    const error = await acquireToken(credentials, { ...TARGET, fetch }).catch((e: unknown) => e);

    assert.ok(error instanceof LogAuthError);
    assert.equal(error.kind, "permanent");
    assert.equal(isPermanentAuthError(error), true);
  });

  test("classifies a 412 from login as permanent (OTP required)", async () => {

    const { fetch } = recordingFetch(() => jsonResponse({ message: "2fa-required" }, 412));
    const credentials: LogClientCredentials = { kind: "password", password: "secret", username: "admin" };

    const error = await acquireToken(credentials, { ...TARGET, fetch }).catch((e: unknown) => e);

    assert.ok(error instanceof LogAuthError);
    assert.equal(error.kind, "permanent");
    assert.match(error.message, /one-time passcode|otp/i, "the OTP-required message must mention the passcode");
  });

  test("classifies a 403 from noauth as permanent (noauth disabled)", async () => {

    const { fetch } = recordingFetch(() => jsonResponse({ message: "Forbidden" }, 403));

    const error = await acquireToken({ kind: "noauth" }, { ...TARGET, fetch }).catch((e: unknown) => e);

    assert.ok(error instanceof LogAuthError);
    assert.equal(error.kind, "permanent");
    assert.match(error.message, /authentication disabled|none/i, "the noauth-disabled message must advise enabling the none auth mode");
  });

  test("classifies a 400 from noauth as a permanent protocol error, not an auth-disabled hint", async () => {

    // Fastify (the homebridge-config-ui-x HTTP server) answers a malformed request with 400, whereas a server that simply is not in no-auth mode answers the no-auth
    // path with 401. A 400 must therefore read as a request/protocol problem and must never be misreported as "authentication is not disabled": a bodyless POST with a
    // declared JSON content-type is a malformed-request condition, not a credential condition.
    const { fetch } = recordingFetch(() => jsonResponse({ message: "Body cannot be empty when content-type is set to 'application/json'" }, 400));

    const error = await acquireToken({ kind: "noauth" }, { ...TARGET, fetch }).catch((e: unknown) => e);

    assert.ok(error instanceof LogAuthError);
    assert.equal(error.kind, "permanent");
    assert.match(error.message, /malformed|protocol|HTTP 400/i, "a 400 must read as a malformed or protocol error");
    assert.doesNotMatch(error.message, /authentication disabled/i, "a 400 must not be misreported as authentication-not-disabled");
  });

  test("classifies a 500 as transient (server-side fault)", async () => {

    const { fetch } = recordingFetch(() => jsonResponse({ message: "Internal Server Error" }, 500));
    const credentials: LogClientCredentials = { kind: "password", password: "secret", username: "admin" };

    const error = await acquireToken(credentials, { ...TARGET, fetch }).catch((e: unknown) => e);

    assert.ok(error instanceof LogAuthError);
    assert.equal(error.kind, "transient");
    assert.equal(isPermanentAuthError(error), false);
  });

  test("classifies a network rejection as transient", async () => {

    const { fetch } = recordingFetch(() => { throw new Error("ECONNREFUSED 127.0.0.1:8581"); });
    const credentials: LogClientCredentials = { kind: "password", password: "secret", username: "admin" };

    const error = await acquireToken(credentials, { ...TARGET, fetch }).catch((e: unknown) => e);

    assert.ok(error instanceof LogAuthError);
    assert.equal(error.kind, "transient");
    assert.match(error.message, /could not reach/i);
  });

  test("classifies a 2xx success with no access token as permanent (broken contract)", async () => {

    // A 200 whose JSON body carries no `access_token` field at all - the success contract is broken, which is classified permanent.
    const { fetch } = recordingFetch(() => jsonResponse({ status: "ok" }));

    const error = await acquireToken({ kind: "noauth" }, { ...TARGET, fetch }).catch((e: unknown) => e);

    assert.ok(error instanceof LogAuthError);
    assert.equal(error.kind, "permanent");
    assert.match(error.message, /no access token/i);
  });

  test("classifies a 2xx success with an unreadable body as permanent", async () => {

    const { fetch } = recordingFetch(() => new Response("not json at all", { status: 200 }));

    const error = await acquireToken({ kind: "noauth" }, { ...TARGET, fetch }).catch((e: unknown) => e);

    assert.ok(error instanceof LogAuthError);
    assert.equal(error.kind, "permanent");
  });
});

describe("acquireToken - actionable, token-safe errors", () => {

  test("surfaces the server's error message detail in the failure", async () => {

    const { fetch } = recordingFetch(() => jsonResponse({ message: "Account is locked" }, 401));
    const credentials: LogClientCredentials = { kind: "password", password: "secret", username: "admin" };

    const error = await acquireToken(credentials, { ...TARGET, fetch }).catch((e: unknown) => e);

    assert.ok(error instanceof LogAuthError);
    assert.match(error.message, /Account is locked/, "the server's detail message must be surfaced for the user");
  });

  test("never leaks a pre-acquired token into an error path", async () => {

    // The token arm never performs a network call, so there is no error path that could carry the token; this asserts the no-leak contract on the failing password arm,
    // whose error must not contain any token-like material.
    const { fetch } = recordingFetch(() => jsonResponse({ message: "Unauthorized" }, 401));
    const credentials: LogClientCredentials = { kind: "password", password: "super-secret-password", username: "admin" };

    const error = await acquireToken(credentials, { ...TARGET, fetch }).catch((e: unknown) => e);

    assert.ok(error instanceof LogAuthError);
    assert.doesNotMatch(error.message, /super-secret-password/, "the error message must never echo the credential material");
  });

  test("never repeats an unreadable success body in the failure or anything it carries", async () => {

    const cases: readonly { readonly body: string; readonly message: string }[] = [

      // This body stays short and opens with a character JSON cannot open with, because the platform parser quotes a body of that length whole...so this row fails
      // if the parser's error ever reaches the failure.
      {

        body: "SECRET-BODY-TEXT",
        message: "No-auth authentication succeeded but returned an unreadable response body: The response body is not valid JSON."
      },
      {

        body: "{\"access_token\": \"SECRET-BODY-TEXT",
        message: "No-auth authentication succeeded but returned an unreadable response body: The response body is not valid JSON at line 1, column 35."
      }
    ];

    for(const { body, message } of cases) {

      const { fetch } = recordingFetch(() => new Response(body, { status: 200 }));

      // eslint-disable-next-line no-await-in-loop
      const error = await acquireToken({ kind: "noauth" }, { ...TARGET, fetch }).catch((e: unknown) => e);

      assert.ok(error instanceof LogAuthError);
      assert.equal(error.kind, "permanent");
      assert.equal(error.message, message);
      assert.doesNotMatch(formatErrorMessage(error), /SECRET-BODY-TEXT/, "the rendered failure must never repeat the response body");
      assert.doesNotMatch(inspect(error, { depth: Infinity }), /SECRET-BODY-TEXT/, "nothing the failure carries may hold the response body");
    }
  });

  test("never carries a well-formed success body that holds no access token", async () => {

    // The token sits under a key the client does not read, so the body is well-formed and still carries it.
    const { fetch } = recordingFetch(() => jsonResponse({ token: "SECRET-BODY-TEXT" }));

    const error = await acquireToken({ kind: "noauth" }, { ...TARGET, fetch }).catch((e: unknown) => e);

    assert.ok(error instanceof LogAuthError);
    assert.equal(error.kind, "permanent");
    assert.equal(error.message, "No-auth authentication succeeded but returned no access token.");
    assert.doesNotMatch(formatErrorMessage(error), /SECRET-BODY-TEXT/, "the rendered failure must never repeat the response body");
    assert.doesNotMatch(inspect(error, { depth: Infinity }), /SECRET-BODY-TEXT/, "nothing the failure carries may hold the response body");
  });

  test("isPermanentAuthError returns false for a non-auth error", () => {

    assert.equal(isPermanentAuthError(new Error("some other error")), false);
    assert.equal(isPermanentAuthError(null), false);
    assert.equal(isPermanentAuthError(new LogAuthError("transient fault", { kind: "transient" })), false);
  });
});

describe("acquireToken - cancellation", () => {

  // A fetch double that treats its signal the way the platform's fetch does: the request stays open until the signal it was handed aborts, then rejects with that
  // signal's reason. `open` counts the requests still in flight, so a test can assert that none outlives the abort. A request that never receives the signal stays
  // open forever, which each test's bounded wait turns into a failure rather than a hang.
  const hangingFetch = (): { calls: { init: RequestInit | undefined; url: string }[]; fetch: typeof fetch; open: () => number } => {

    let open = 0;

    const { calls, fetch } = recordingFetch((_url, init) => new Promise<Response>((_resolve, reject) => {

      const signal = init?.signal;

      open++;

      signal?.addEventListener("abort", () => {

        open--;
        reject(signal.reason as Error);
      }, { once: true });
    }));

    return { calls, fetch, open: (): number => open };
  };

  test("aborting a login in flight rejects promptly with the signal's reason and leaves no request open", async () => {

    const { calls, fetch, open } = hangingFetch();
    const controller = new AbortController();
    const reason = new Error("The client was torn down.");
    let outcome: unknown;

    const login = acquireToken({ kind: "password", password: "secret", username: "admin" }, { ...TARGET, fetch, signal: controller.signal }).
      catch((error: unknown) => { outcome = error; });

    await waitUntil(() => calls.length === 1, { description: "the login request to go out" });

    controller.abort(reason);

    await waitUntil(() => outcome !== undefined, { description: "the login to reject once its signal aborts", timeoutMs: 500 });
    await login;

    assert.equal(outcome, reason, "the rejection is the signal's own reason, not an authentication failure");
    assert.equal(open(), 0, "the aborted request is no longer open");
  });

  test("an abort while the login's response is being read rejects with the signal's reason rather than a permanent failure", async () => {

    // The server has answered and its body is still arriving when the signal aborts, so the double errors the body stream with the signal's reason, as the platform
    // does for a response whose request was aborted. Reading that body is where a broken success response is classified permanent, so unless the abort takes
    // precedence, a teardown would read as credentials that can never work.
    const controller = new AbortController();
    const reason = new Error("The client was torn down.");
    let outcome: unknown;

    const { fetch } = recordingFetch((_url, init) => new Response(new ReadableStream<Uint8Array>({

      start(stream): void {

        const signal = init?.signal;

        signal?.addEventListener("abort", () => stream.error(signal.reason), { once: true });
      }
    }), { status: 200 }));

    const login = acquireToken({ kind: "noauth" }, { ...TARGET, fetch, signal: controller.signal }).catch((error: unknown) => { outcome = error; });

    // Let the response arrive and its body read begin before the abort lands.
    await settle();

    controller.abort(reason);

    await waitUntil(() => outcome !== undefined, { description: "the login to reject once its signal aborts", timeoutMs: 500 });
    await login;

    assert.equal(outcome, reason, "the abort, not the unreadable body, is what the rejection reports");
  });
});
