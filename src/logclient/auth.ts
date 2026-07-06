/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * logclient/auth.ts: Token acquisition against the homebridge-config-ui-x authentication API.
 */

/**
 * Token acquisition for the Homebridge UI log client.
 *
 * {@link acquireToken} turns a {@link LogClientCredentials} discriminated union into a raw bearer token by talking to the homebridge-config-ui-x authentication API. Each
 * credential arm maps to one of the server's authentication paths: a pre-acquired `token` is returned verbatim with no network call, a `password` arm posts to `POST
 * /api/auth/login` (carrying an optional one-time passcode), and `noauth` posts to `POST /api/auth/noauth`, which the server honors only when its UI is configured with
 * `auth: "none"`.
 *
 * The module's load-bearing concern beyond "get a token" is failure classification. The socket's reconnect loop re-authenticates on every reconnect, so it must be able
 * to tell a transient fault (the server is briefly down or returned a 5xx) from a permanent one (the credentials are wrong, an OTP is required, or noauth is disabled).
 * A transient fault should be retried with backoff; a permanent one must fail the reconnect fast so the user gets an actionable error rather than an endless retry loop
 * against credentials that will never work. {@link acquireToken} therefore rejects with a {@link LogAuthError} whose `kind` discriminates `"permanent"` from
 * `"transient"`, and the reconnect's `shouldRetry` predicate vetoes a retry on the permanent kind via {@link isPermanentAuthError}.
 *
 * The `fetch` implementation is injected (defaulting to the global `fetch`) so the whole module is exercised in tests without a live server.
 *
 * @module
 */
import type { EndpointTarget } from "./endpoints.ts";
import type { LogClientCredentials } from "./types.ts";
import { formatErrorMessage } from "../util.ts";
import { httpBaseUrl } from "./endpoints.ts";

// The auth API returns these status codes for a genuine credential or precondition problem: 401 (wrong username/password, or the no-auth path used against a server not
// in "none" mode), 403 (account disabled or action not permitted), and 412 (a one-time passcode is required but was not supplied). All three keep failing until the
// caller changes the credentials or supplies an OTP, so they are classified permanent and the reconnect loop must not retry them. A 400 is handled separately (see
// throwForStatus): it is a malformed-request / protocol mismatch, not a credential problem, so it carries a different message even though it too is permanent.
const CREDENTIAL_STATUS = new Set<number>([ 401, 403, 412 ]);

/**
 * The classification of an authentication failure, used by the reconnect loop to decide whether to retry.
 *
 * - `"permanent"` - the credentials are wrong, an OTP is required, or noauth is disabled. Retrying with the same credentials will keep failing, so the reconnect loop
 *   vetoes a retry and surfaces the error to the user.
 * - `"transient"` - a network fault or a server-side 5xx/429. The condition may clear on its own, so the reconnect loop retries with backoff.
 *
 * @category Log Client
 */
export type LogAuthErrorKind = "permanent" | "transient";

/**
 * Options accepted by {@link LogAuthError}'s constructor.
 *
 * @property cause - The underlying cause (a network error, or the HTTP response context), attached for diagnostics.
 * @property kind  - The failure classification. See {@link LogAuthErrorKind}.
 *
 * @category Log Client
 */
export interface LogAuthErrorOptions {

  readonly cause?: unknown;
  readonly kind: LogAuthErrorKind;
}

/**
 * The error thrown by {@link acquireToken} when authentication fails.
 *
 * Carries a {@link LogAuthErrorKind} discriminator so a consumer (specifically the socket's reconnect `shouldRetry` predicate) can distinguish a permanent credential
 * problem from a transient network/server fault without parsing the message text. The message itself is already actionable - it names the failing path and the reason -
 * so it can be surfaced to the user directly.
 *
 * @category Log Client
 */
export class LogAuthError extends Error {

  /**
   * The failure classification. `"permanent"` failures must not be retried; `"transient"` failures may be.
   */
  public readonly kind: LogAuthErrorKind;

  /**
   * Construct a new authentication error.
   *
   * @param message - A human-readable, actionable description of the failure.
   * @param options - The classification and optional underlying cause. See {@link LogAuthErrorOptions}.
   */
  public constructor(message: string, options: LogAuthErrorOptions) {

    super(message, { cause: options.cause });
    this.kind = options.kind;
    this.name = "LogAuthError";
  }
}

/**
 * Type guard: returns `true` when `error` is a {@link LogAuthError} classified `"permanent"`.
 *
 * The reconnect loop's `shouldRetry` predicate consults this to veto a retry the instant a permanent credential failure surfaces, so a wrong password or a missing OTP
 * fails the reconnect fast rather than looping forever against credentials that cannot succeed.
 *
 * @param error - The value to test.
 *
 * @returns `true` when `error` is a permanent authentication failure.
 *
 * @category Log Client
 */
export function isPermanentAuthError(error: unknown): boolean {

  return (error instanceof LogAuthError) && (error.kind === "permanent");
}

/**
 * Options accepted by {@link acquireToken}: the connection target plus an injectable `fetch` seam.
 *
 * @property fetch - The fetch implementation to use. Defaults to the global `fetch`. Injected so the auth flow is testable without a live server.
 * @property host  - The hostname or IP of the homebridge-config-ui-x server.
 * @property port  - The TCP port the server listens on.
 * @property tls   - When `true`, use the secure (`https`) scheme; when `false` or omitted, plaintext (`http`).
 *
 * @category Log Client
 */
export interface AcquireTokenOptions extends EndpointTarget {

  readonly fetch?: typeof fetch;
}

// Read a token out of a successful auth response body. The server returns `{ access_token, token_type: "Bearer", expires_in }`; we need only `access_token`. A 2xx
// response whose body is missing or malformed is treated as a permanent failure, because a server that answers a valid request with an unparseable success body will
// not behave differently on retry - the contract is broken, not the moment.
async function readAccessToken(response: Response, pathLabel: string): Promise<string> {

  let body: unknown;

  try {

    body = await response.json();
  } catch(error: unknown) {

    throw new LogAuthError(pathLabel + " succeeded but returned an unreadable response body: " + formatErrorMessage(error) + ".", { cause: error, kind: "permanent" });
  }

  const token = isRecord(body) ? body["access_token"] : undefined;

  if(typeof token !== "string") {

    throw new LogAuthError(pathLabel + " succeeded but returned no access token.", { cause: body, kind: "permanent" });
  }

  return token;
}

// Narrow an unknown value to a plain record so a single top-level string property (such as `access_token` or `message`) can be read off a parsed JSON body without unsafe
// member access.
function isRecord(value: unknown): value is Record<string, unknown> {

  return (typeof value === "object") && (value !== null);
}

// Classify and throw for a non-2xx auth response. The status code is the discriminator: the codes in `CREDENTIAL_STATUS` describe a credential problem that will not
// clear on retry, so they raise a permanent failure with a path-specific, actionable message; a 400 is handled separately below as a permanent protocol error, and every
// other status (notably 5xx and 429) is treated as transient so the reconnect loop retries with backoff. The body is read best-effort for context but never required - a
// server returning an error status with no body still produces a clear message.
async function throwForStatus(response: Response, pathLabel: string, permanentHint: string): Promise<never> {

  const detail = await readErrorDetail(response);
  const suffix = (detail.length > 0) ? (": " + detail) : "";

  // A genuine credential or precondition rejection (401/403/412): the caller must change something, so surface the path-specific, actionable hint. Permanent - retrying
  // the same credentials cannot succeed.
  if(CREDENTIAL_STATUS.has(response.status)) {

    throw new LogAuthError(pathLabel + " failed - " + permanentHint + suffix + ".", { cause: { status: response.status }, kind: "permanent" });
  }

  // A 400 is a malformed-request / protocol mismatch, not a credential problem - a server that merely is not in no-auth mode answers the no-auth path with 401, never
  // 400. It is permanent (the identical request keeps failing) but it points at a request or homebridge-config-ui-x version mismatch rather than the credentials.
  if(response.status === 400) {

    throw new LogAuthError(pathLabel + " failed - the server rejected the request as malformed (HTTP 400)" + suffix +
      "; this usually indicates a homebridge-config-ui-x version or protocol mismatch.", { cause: { status: 400 }, kind: "permanent" });
  }

  // Everything else (notably 5xx and 429) may clear on its own, so it is transient and the reconnect loop retries it with backoff.
  throw new LogAuthError(pathLabel + " failed - the server returned HTTP " + response.status.toString() + " (" + response.statusText + ")" + suffix + ".",
    { cause: { status: response.status }, kind: "transient" });
}

// Best-effort read of an error response's human-readable detail. homebridge-config-ui-x typically returns `{ message, error, statusCode }` on a failure; we surface the
// `message` when present, falling back to the raw text. A body that cannot be read at all yields an empty string so the caller's message still reads cleanly without it.
async function readErrorDetail(response: Response): Promise<string> {

  let text: string;

  try {

    text = await response.text();
  } catch {

    return "";
  }

  if(text.length === 0) {

    return "";
  }

  try {

    const parsed: unknown = JSON.parse(text);
    const message = isRecord(parsed) ? parsed["message"] : undefined;

    if(typeof message === "string") {

      return message;
    }
  } catch {

    // Not JSON; fall through and surface the raw text trimmed of its trailing period so it composes cleanly with the caller's own trailing period.
  }

  return text.replace(/\.$/, "");
}

// Wrap a network-level fetch rejection (DNS failure, connection refused, TLS error) as a transient authentication failure. A connection that cannot be established may
// succeed on a later attempt, so the reconnect loop should retry rather than give up.
function networkFailure(pathLabel: string, error: unknown): LogAuthError {

  return new LogAuthError(pathLabel + " could not reach the server: " + formatErrorMessage(error) + ".", { cause: error, kind: "transient" });
}

/**
 * Acquire a raw bearer token for the homebridge-config-ui-x API from the supplied credentials.
 *
 * Dispatches on the credential discriminated union:
 *
 * - `token` - returns the pre-acquired token verbatim, with no network call. A static token that has since expired is not detected here; the failure surfaces later when
 *   the socket handshake is rejected.
 * - `password` - posts `{ username, password, otp? }` to `POST /api/auth/login`.
 * - `noauth` - posts to `POST /api/auth/noauth`, which the server honors only when its UI is configured with `auth: "none"`.
 *
 * On failure it rejects with a {@link LogAuthError} whose `kind` classifies the failure as permanent (wrong credentials, OTP required, noauth disabled, broken success
 * body) or transient (network fault, 5xx, 429), so the reconnect loop can fail fast on permanent failures and retry transient ones.
 *
 * @param credentials - The credentials to authenticate with. See {@link LogClientCredentials}.
 * @param options     - The connection target and the injectable `fetch` seam. See {@link AcquireTokenOptions}.
 *
 * @returns A promise resolving to the raw bearer token (the bare JWT, with no `Bearer` prefix).
 *
 * @throws {@link LogAuthError} on any authentication failure, classified permanent or transient.
 *
 * @category Log Client
 */
export async function acquireToken(credentials: LogClientCredentials, options: AcquireTokenOptions): Promise<string> {

  // A pre-acquired token needs no network round-trip; return it verbatim. The token arm is handled first so the common "I already have a token" path costs nothing.
  if(credentials.kind === "token") {

    return credentials.token;
  }

  const fetchImpl = options.fetch ?? fetch;
  const base = httpBaseUrl(options);

  switch(credentials.kind) {

    case "noauth": {

      // The no-authentication path. The server returns a token from `POST /api/auth/noauth` only when its UI is configured with `auth: "none"`; otherwise it rejects,
      // which we classify permanent because the server's auth mode will not change between reconnect attempts.
      return postForToken(fetchImpl, base + "/api/auth/noauth", undefined, "No-auth authentication",
        "the server does not have authentication disabled (set the UI auth mode to \"none\", or supply --user/--pass)");
    }

    case "password": {

      // The interactive login path. We post the username, password, and optional OTP. A 401/403 means the credentials are wrong; a 412 means an OTP is required - both
      // permanent until the caller supplies correct credentials or a passcode.
      const body: Record<string, string> = { password: credentials.password, username: credentials.username };

      if(credentials.otp !== undefined) {

        body["otp"] = credentials.otp;
      }

      return postForToken(fetchImpl, base + "/api/auth/login", body, "Password authentication",
        "the username, password, or one-time passcode was rejected (a 2FA-enabled account requires --otp)");
    }

    default: {

      // The union is exhausted above (the `token` arm returned earlier). This satisfies exhaustiveness and guards against a future credential arm being added without a
      // handler here.
      throw new LogAuthError("Unsupported credential kind.", { cause: credentials, kind: "permanent" });
    }
  }
}

// Issue a single POST to an auth endpoint and extract the access token, mapping every failure shape to a classified {@link LogAuthError}. A JSON body is sent when one is
// supplied (the login path); the noauth path posts with no body. Network rejections are transient; non-2xx statuses are classified by `throwForStatus`.
async function postForToken(fetchImpl: typeof fetch, url: string, body: Record<string, string> | undefined, pathLabel: string, permanentHint: string): Promise<string> {

  // The JSON content-type header is a claim that a JSON body follows, so the two are derived together from a single condition: a request that carries a body
  // declares `application/json` and serializes it, and a bodyless request (the no-auth path) sends neither. This coupling is the single source of truth that keeps
  // every auth POST well-formed - declaring `application/json` with no body is incoherent, and Fastify (the homebridge-config-ui-x HTTP server) rejects a
  // declared-JSON body that is empty.
  const init: RequestInit = (body !== undefined) ?
    { body: JSON.stringify(body), headers: { "Content-Type": "application/json" }, method: "POST" } :
    { method: "POST" };

  let response: Response;

  try {

    response = await fetchImpl(url, init);
  } catch(error: unknown) {

    throw networkFailure(pathLabel, error);
  }

  if(!response.ok) {

    return throwForStatus(response, pathLabel, permanentHint);
  }

  return readAccessToken(response, pathLabel);
}
