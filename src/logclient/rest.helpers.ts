/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * logclient/rest.helpers.ts: The `fetch` doubles the log client's suites share, standing in for the homebridge-config-ui-x REST API's token and download endpoints.
 *
 * Every suite that drives the token or download transports needs the same few pieces: a `fetch` that records what it was asked, the server-shaped token body, a
 * download answered with a log, and a server that routes the token endpoints apart from the download so a suite states only the download it cares about. They live
 * here once. The open download goes further than a fixed body can: it stays open until its test closes it, and once the request's signal aborts it errors a pending
 * read with the signal's reason, as the platform `fetch` does, so a caller's teardown and the download's stall bound each reach the reader as they would in
 * production. None of it ships - the build's emit config excludes every helpers file by name.
 */
import { onAbort } from "../util.ts";

/**
 * A `fetch` call as a recording double captured it: the init it was handed and the URL it named.
 */
export interface FetchCall {

  readonly init: RequestInit | undefined;
  readonly url: string;
}

/**
 * A recording `fetch` double and the calls it has captured, oldest first.
 */
export interface RecordingFetch {

  readonly calls: FetchCall[];
  readonly fetch: typeof fetch;
}

/**
 * An open log-download response and the levers that feed it.
 *
 * @property close    - End the body normally, as a server reaching the end of the file does.
 * @property push     - Deliver more body text, as one chunk.
 * @property response - The 200 response a `fetch` double answers the download with.
 */
export interface OpenDownload {

  readonly close: () => void;
  readonly push: (text: string) => void;
  readonly response: Response;
}

/**
 * The URL a `fetch` call names, whichever form the caller passed it in.
 *
 * @param input - The first argument the call was handed.
 *
 * @returns The URL as a string.
 */
export function requestUrl(input: string | URL | Request): string {

  return (typeof input === "string") ? input : (input instanceof URL) ? input.href : input.url;
}

/**
 * Build a `fetch` double that records every call and answers it with whatever `respond` returns.
 *
 * @param respond - The answer to each call, given the URL it named and the init it was handed.
 *
 * @returns The double and its captured calls.
 */
export function recordingFetch(respond: (url: string, init: RequestInit | undefined) => Promise<Response> | Response): RecordingFetch {

  const calls: FetchCall[] = [];

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {

    const url = requestUrl(input);

    calls.push({ init, url });

    return respond(url, init);
  }) as typeof fetch;

  return { calls, fetch: fetchImpl };
}

/**
 * Build a server-shaped token-endpoint success body carrying `token`, assembled with bracket-notation keys so the snake_case wire field names do not trip the camelcase
 * lint rule in test source (the production auth code reads these same fields through string index access for the same reason).
 *
 * @param token - The access token the body carries.
 *
 * @returns The body, ready for `JSON.stringify`.
 */
export function tokenBody(token: string): Record<string, unknown> {

  const body: Record<string, unknown> = {};

  body["access_token"] = token;
  body["expires_in"] = 28800;
  body["token_type"] = "Bearer";

  return body;
}

/**
 * Build a 200 log-download response carrying `lines`, each terminated so the splitter yields it as a complete line, the whole log delivered at once.
 *
 * @param lines - The raw log lines, oldest first.
 *
 * @returns The response.
 */
export function logResponse(lines: readonly string[]): Response {

  return new Response(lines.map((line) => line + "\n").join(""), { status: 200 });
}

/**
 * Build a `fetch` double standing in for the homebridge-config-ui-x API: every token endpoint answers with a fresh token, and the log download answers with whatever
 * `download` returns for its request. Every call is recorded, so a suite asserts which endpoints a run reached.
 *
 * @param download - The answer to the log download, given the init the request was handed.
 *
 * @returns The double and its captured calls.
 */
export function uiServer(download: (init: RequestInit | undefined) => Promise<Response> | Response): RecordingFetch {

  return recordingFetch((url, init) => url.includes("/log/download") ? download(init) : new Response(JSON.stringify(tokenBody("fresh.jwt")), { status: 200 }));
}

/**
 * Build a {@link uiServer} whose log download carries `lines` but answers only once `resolveHistory` is called, so a suite can let a socket's seed buffer fully before
 * the history lands and the join it tests runs in a known order.
 *
 * @param lines - The raw log lines the download carries, oldest first.
 *
 * @returns The double, its captured calls, and the lever that lets the download answer.
 */
export function deferredUiServer(lines: readonly string[]): RecordingFetch & { readonly resolveHistory: () => void } {

  const gate: PromiseWithResolvers<void> = Promise.withResolvers();

  const server = uiServer(async (): Promise<Response> => {

    await gate.promise;

    return logResponse(lines);
  });

  return { ...server, resolveHistory: (): void => gate.resolve() };
}

/**
 * Build an open log-download response that delivers `chunks` at once, one chunk each, and then sends nothing more until the test pushes or closes.
 *
 * @param options        - The response's opening content and the request it answers.
 * @param options.chunks - The body text delivered at once, one chunk per entry. Defaults to none.
 * @param options.signal - The signal the download handed `fetch`. Once it aborts, a pending read rejects with its reason. Omitted, the body ignores aborts.
 *
 * @returns The response and the levers that feed it.
 */
export function openDownload({ chunks = [], signal }: { chunks?: readonly string[]; signal?: AbortSignal }): OpenDownload {

  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;

  const body = new ReadableStream<Uint8Array>({

    start(streamController): void {

      controller = streamController;

      for(const chunk of chunks) {

        streamController.enqueue(encoder.encode(chunk));
      }
    }
  });

  // Mirror the platform: an aborted request errors its body with the signal's reason, so a read waiting on a silent server rejects rather than hanging. Erroring a body
  // the test already closed and drained does nothing, exactly as the platform has nothing left to tear down there.
  if(signal !== undefined) {

    onAbort(signal, (): void => controller?.error(signal.reason));
  }

  return {

    close: (): void => controller?.close(),
    push: (text: string): void => controller?.enqueue(encoder.encode(text)),
    response: new Response(body, { status: 200 })
  };
}
