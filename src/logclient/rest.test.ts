/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * logclient/rest.test.ts: Unit tests for the streamed whole-file log download - line splitting via the shared splitter, the end-of-response flush, the 400 mapping,
 * and the stall bound.
 */
import { assertNoUnhandledRejections, present, settle } from "../testing/index.ts";
import { describe, test } from "node:test";
import { DOWNLOAD_STALL_MS } from "./settings.ts";
import type { DownloadLogOptions } from "./rest.ts";
import type { OpenDownload } from "./rest.helpers.ts";
import { TestClock } from "../clock-double.ts";
import assert from "node:assert/strict";
import { downloadLog } from "./rest.ts";
import { onAbort } from "../util.ts";
import { openDownload } from "./rest.helpers.ts";

// The connection target plus token every test reuses. The download flow builds `http://localhost:8581/api/platform-tools/hb-service/log/download?colour=yes`.
const TARGET = { host: "localhost", port: 8581, token: "raw.jwt" };

// A captured fetch call: the request init and the URL string the download flow produced.
interface FetchCall {

  init: RequestInit | undefined;
  url: string;
}

// Build an injected `fetch` double that captures the request and returns a caller-supplied response. The captured call lets a test assert the URL, the colour=yes
// query, and the Authorization header.
function fakeFetch(responder: (url: string, init: RequestInit | undefined) => Response): { calls: FetchCall[]; fetch: typeof fetch } {

  const calls: FetchCall[] = [];

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {

    const url = (typeof input === "string") ? input : (input instanceof URL) ? input.href : input.url;

    calls.push({ init, url });

    return responder(url, init);
  }) as typeof fetch;

  return { calls, fetch: fetchImpl };
}

// Build a 200 `Response` whose body streams the supplied text chunks one at a time, so a test can exercise the splitter's cross-chunk reassembly. The chunks are encoded
// to bytes (the production code decodes with a streaming `TextDecoder`), so a multi-byte sequence can be split across chunk boundaries in a test that wants to.
function streamingResponse(chunks: readonly string[]): Response {

  const encoder = new TextEncoder();

  const body = new ReadableStream<Uint8Array>({

    start(controller): void {

      for(const chunk of chunks) {

        controller.enqueue(encoder.encode(chunk));
      }

      controller.close();
    }
  });

  return new Response(body, { status: 200 });
}

// Drain the download iterable into an array of lines for assertion.
async function collect(options: DownloadLogOptions): Promise<string[]> {

  const lines: string[] = [];

  for await (const line of downloadLog(options)) {

    lines.push(line);
  }

  return lines;
}

// The captured surface of an abort-observing `fetch` double.
//
// @property fetch        - The `fetch` implementation to inject.
// @property signalSeen   - The `signal` the download forwarded to `fetch`, captured on the call. `undefined` until `fetch` is invoked, or when no signal was forwarded.
// @property wasCancelled - Whether the response body's underlying-source `cancel()` has run - i.e., `readLines` cancelled the still-open reader in its `finally` because
//                          the call was aborted. Proves the body was torn down rather than drained to EOF.
interface AbortObservingFetch {

  fetch: typeof fetch;
  signalSeen: () => AbortSignal | undefined;
  wasCancelled: () => boolean;
}

// Build an abort-observing `fetch` double. Unlike `streamingResponse` above, the body it returns deliberately does NOT auto-close: it enqueues the supplied lines and
// stays open, so a consumer that stops before its (never-arriving) end can only have stopped because the download was aborted. The double captures the `signal` the
// download forwarded to `fetch` and records when the body's reader is cancelled, so a test can prove an aborted download both forwarded its signal and released the body
// reader. A pre-aborted signal is rejected synchronously, mirroring how the platform `fetch` short-circuits before issuing a request.
function abortObservingFetch(lines: readonly string[]): AbortObservingFetch {

  const encoder = new TextEncoder();
  let cancelled = false;
  let seen: AbortSignal | undefined;

  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {

    seen = init?.signal ?? undefined;

    // A pre-aborted signal short-circuits exactly as the platform `fetch` does - reject before any body is produced - so `downloadLog` never begins streaming.
    if(init?.signal?.aborted === true) {

      throw init.signal.reason;
    }

    const body = new ReadableStream<Uint8Array>({

      // `readLines` cancels the reader in its `finally` when the call was aborted; an open-stream cancel surfaces here (synchronously, inside `reader.cancel()`), so a
      // test asserts the body was torn down early rather than drained to EOF.
      cancel(): void {

        cancelled = true;
      },

      // Enqueue the seed lines but deliberately do NOT close: the body stays open past them, so a consumer that stops before EOF can only have stopped because of the
      // abort.
      start(controller): void {

        for(const line of lines) {

          controller.enqueue(encoder.encode(line + "\n"));
        }
      }
    });

    return new Response(body, { status: 200 });
  }) as typeof fetch;

  return { fetch: fetchImpl, signalSeen: (): AbortSignal | undefined => seen, wasCancelled: (): boolean => cancelled };
}

// The error a stalled download fails with, restated here so a change to the user-facing wording is a deliberate one. A rejection is matched against the error's
// string form, which leads with its name, so the pattern anchors only at the end.
const STALL_PATTERN = new RegExp("Log download stalled - the server sent no data for " + (DOWNLOAD_STALL_MS / 1000).toString() + " seconds\\.$");

// The captured surface of a `fetch` double standing in for a server that goes quiet.
//
// @property download - The open download the server answered with, once it has answered.
// @property fetch    - The `fetch` implementation to inject.
// @property signal   - The signal the download handed `fetch`, once it has been called.
interface QuietServer {

  download: () => OpenDownload | undefined;
  fetch: typeof fetch;
  signal: () => AbortSignal | undefined;
}

// Build a `fetch` double for a server that goes quiet. It answers the download with an open body that delivers `chunks` and then waits on the test, or, with `answer`
// false, never answers at all - until the request's signal aborts, when it rejects with the signal's reason, as the platform `fetch` does.
function quietServer({ answer = true, chunks = [] }: { answer?: boolean; chunks?: readonly string[] } = {}): QuietServer {

  let download: OpenDownload | undefined;
  let seen: AbortSignal | undefined;

  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {

    const signal = present(init?.signal, "the download's request signal");

    seen = signal;

    if(!answer) {

      await new Promise<void>((resolve) => {

        onAbort(signal, resolve);
      });

      throw signal.reason;
    }

    download = openDownload({ chunks, signal });

    return download.response;
  }) as typeof fetch;

  return { download: (): OpenDownload | undefined => download, fetch: fetchImpl, signal: (): AbortSignal | undefined => seen };
}

describe("downloadLog - request shape", () => {

  test("requests colour=yes with the bearer token", async () => {

    const { calls, fetch } = fakeFetch(() => streamingResponse([ "one\n", "two\n" ]));

    await collect({ ...TARGET, fetch });

    const call = calls[0];

    assert.ok(call !== undefined);
    assert.ok(call.init !== undefined);
    assert.equal(call.url, "http://localhost:8581/api/platform-tools/hb-service/log/download?colour=yes");
    assert.equal(call.init.method, "GET");
    assert.equal((call.init.headers as Record<string, string>)["Authorization"], "Bearer raw.jwt");
  });

  test("builds an https URL when tls is set", async () => {

    const { calls, fetch } = fakeFetch(() => streamingResponse(["x\n"]));

    await collect({ ...TARGET, fetch, tls: true });

    const call = calls[0];

    assert.ok(call !== undefined);
    assert.match(call.url, /^https:\/\/localhost:8581\//);
  });
});

describe("downloadLog - streaming and splitting", () => {

  test("yields each complete line across chunk boundaries", async () => {

    // The first line is split across the first two chunks; the splitter must reassemble it.
    const { fetch } = fakeFetch(() => streamingResponse([ "[ts] [Plug] hel", "lo world\n[ts] [Plug] second\n" ]));

    const lines = await collect({ ...TARGET, fetch });

    assert.deepEqual(lines, [ "[ts] [Plug] hello world", "[ts] [Plug] second" ]);
  });

  test("flushes the final unterminated line at end-of-response", async () => {

    // The last line has no trailing newline. Without the end-of-response flush it would be stranded in the splitter's carry; the flush must surface it.
    const { fetch } = fakeFetch(() => streamingResponse([ "first\n", "last line with no newline" ]));

    const lines = await collect({ ...TARGET, fetch });

    assert.deepEqual(lines, [ "first", "last line with no newline" ], "the final unterminated line must be flushed, not stranded");
  });

  test("flushes a final line that ends exactly on a lone line-feed", async () => {

    // A chunk ending on a lone line-feed is withheld by the splitter pending a possible cross-chunk pair. At end-of-response the flush must surface that final line.
    const { fetch } = fakeFetch(() => streamingResponse(["alpha\nbeta\n"]));

    const lines = await collect({ ...TARGET, fetch });

    assert.deepEqual(lines, [ "alpha", "beta" ], "a final line ending on a lone line-feed must surface via the end-of-response flush");
  });

  test("reassembles a multi-byte UTF-8 sequence split across chunk boundaries", async () => {

    // Split the bytes of a multi-byte character ("é" is 0xC3 0xA9) across two chunks. The streaming TextDecoder must reassemble it rather than emit a replacement char.
    const encoder = new TextEncoder();
    const full = encoder.encode("café\n");
    const cut = full.length - 2;

    const body = new ReadableStream<Uint8Array>({

      start(controller): void {

        controller.enqueue(full.slice(0, cut));
        controller.enqueue(full.slice(cut));
        controller.close();
      }
    });

    const { fetch } = fakeFetch(() => new Response(body, { status: 200 }));

    const lines = await collect({ ...TARGET, fetch });

    assert.deepEqual(lines, ["café"], "a multi-byte sequence split across chunks must decode correctly, not as a replacement character");
  });

  test("yields nothing for an empty body", async () => {

    const { fetch } = fakeFetch(() => streamingResponse([]));

    const lines = await collect({ ...TARGET, fetch });

    assert.deepEqual(lines, []);
  });
});

describe("downloadLog - error mapping", () => {

  test("maps a 400 to a clear 'no log file on disk; use --follow' error", async () => {

    const { fetch } = fakeFetch(() => new Response("Bad Request", { status: 400 }));

    await assert.rejects(collect({ ...TARGET, fetch }), (error: unknown) => {

      assert.ok(error instanceof Error);
      assert.match(error.message, /no log file/i);
      assert.match(error.message, /--follow/, "the 400 mapping must advise --follow");

      return true;
    });
  });

  test("surfaces a non-400 error status with the status code", async () => {

    const { fetch } = fakeFetch(() => new Response("Server Error", { status: 503, statusText: "Service Unavailable" }));

    await assert.rejects(collect({ ...TARGET, fetch }), (error: unknown) => {

      assert.ok(error instanceof Error);
      assert.match(error.message, /503/);

      return true;
    });
  });

  test("surfaces a null body as an error", async () => {

    // A 204 (No Content) is a 2xx-ok response with no body: `new Response(null, { status: 204 })` yields a null `.body`, which must surface as an error.
    const { fetch } = fakeFetch(() => new Response(null, { status: 204 }));

    await assert.rejects(collect({ ...TARGET, fetch }), (error: unknown) => {

      assert.ok(error instanceof Error);
      assert.match(error.message, /empty response body/i);

      return true;
    });
  });
});

describe("downloadLog - abort", () => {

  test("forwards the abort signal to fetch and cancels the body reader on an aborted teardown", async () => {

    const controller = new AbortController();
    const { fetch, signalSeen, wasCancelled } = abortObservingFetch([ "one", "two", "three" ]);

    const iterator = downloadLog({ ...TARGET, fetch, signal: controller.signal })[Symbol.asyncIterator]();

    // Read the first line; the body stays open (the double never closes it), so the download is still in flight and "two"/"three" have not surfaced.
    const first = await iterator.next();

    assert.equal(first.value, "one", "the first line must stream before the abort");

    // Supersede the download: abort the signal, then cease iterating. `readLines`' finally must cancel the still-open reader because the signal is now aborted, releasing
    // the connection rather than leaving it to drain in the background.
    controller.abort(new Error("superseded"));

    await iterator.return?.();

    assert.equal(signalSeen()?.aborted, true, "the download must forward its abort signal to fetch");
    assert.equal(wasCancelled(), true, "an aborted teardown must cancel the body reader rather than leaving the connection draining");
  });

  test("does not cancel the body reader on a normal (un-aborted) early break", async () => {

    // The cancel-on-teardown is gated on `signal?.aborted`: a consumer that simply stops iterating without an abort must release the lock but NOT issue a body cancel.
    const { fetch, wasCancelled } = abortObservingFetch([ "one", "two" ]);

    const iterator = downloadLog({ ...TARGET, fetch })[Symbol.asyncIterator]();

    await iterator.next();
    await iterator.return?.();

    assert.equal(wasCancelled(), false, "an un-aborted early break must not cancel the body reader");
  });

  test("swallows the body-cancel rejection when the stream is already errored on an aborted teardown", async () => {

    // Mirror undici tearing the connection down on abort: the body is errored from the producer side while the call signal is aborted, so the next read rejects and
    // `readLines`' finally cancels an ALREADY-errored reader. That cancel rejects with the stored stream error; it must be swallowed rather than escaping as an unhandled
    // rejection, while the original stream error still propagates to the caller.
    const controller = new AbortController();
    const encoder = new TextEncoder();
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;

    const fetchImpl = (async (): Promise<Response> => {

      const body = new ReadableStream<Uint8Array>({

        // Enqueue a chunk whose newline is not chunk-final ("one\nx"), so the splitter yields "one" on the first read rather than withholding it pending a cross-chunk
        // pair.
        start(c): void {

          streamController = c;
          c.enqueue(encoder.encode("one\nx"));
        }
      });

      return new Response(body, { status: 200 });
    }) as typeof fetch;

    await assertNoUnhandledRejections(async () => {

      const iterator = downloadLog({ ...TARGET, fetch: fetchImpl, signal: controller.signal })[Symbol.asyncIterator]();
      const first = await iterator.next();

      assert.equal(first.value, "one", "the first line must stream before the teardown");

      controller.abort(new Error("superseded"));
      streamController?.error(new Error("connection reset"));

      await assert.rejects(iterator.next(), /connection reset/);
    });
  });

  test("a pre-aborted signal short-circuits before any line is streamed", async () => {

    const controller = new AbortController();

    controller.abort(new Error("already gone"));

    const { fetch, signalSeen } = abortObservingFetch([ "one", "two" ]);
    const lines: string[] = [];

    await assert.rejects((async (): Promise<void> => {

      for await (const line of downloadLog({ ...TARGET, fetch, signal: controller.signal })) {

        lines.push(line);
      }
    })());

    assert.deepEqual(lines, [], "a pre-aborted signal must short-circuit before any line is yielded");
    assert.equal(signalSeen()?.aborted, true, "fetch must have received the pre-aborted signal");
  });
});

describe("downloadLog - stall bound", () => {

  test("fails as stalled once the body has been silent for the whole window, and tears the request down", async () => {

    const clock = new TestClock();
    const server = quietServer({ chunks: ["one\ntwo"] });
    const iterator = downloadLog({ ...TARGET, clock, fetch: server.fetch })[Symbol.asyncIterator]();

    assert.equal((await iterator.next()).value, "one", "the line the server did send must stream before the stall");

    // "two" has no terminator yet, so this pull waits on a server that has gone quiet.
    const pending = iterator.next();
    let settled = false;

    void pending.then(() => {

      settled = true;
    }, () => {

      settled = true;
    });

    await settle();
    clock.advance(DOWNLOAD_STALL_MS - 1);
    await settle();

    assert.equal(settled, false, "the download must hold on until the whole window has passed");

    clock.advance(1);

    await assert.rejects(pending, STALL_PATTERN);
    assert.equal(server.signal()?.aborted, true, "a stall must abort the request so its connection is released");
  });

  test("fails as stalled when the server never answers the request", async () => {

    const clock = new TestClock();
    const server = quietServer({ answer: false });
    const lines = collect({ ...TARGET, clock, fetch: server.fetch });

    await settle();
    clock.advance(DOWNLOAD_STALL_MS);

    await assert.rejects(lines, STALL_PATTERN);
  });

  test("never counts the time the consumer holds the stream against the server", async () => {

    const clock = new TestClock();
    const server = quietServer({ chunks: ["one\ntwo\n"] });
    const iterator = downloadLog({ ...TARGET, clock, fetch: server.fetch })[Symbol.asyncIterator]();

    assert.equal((await iterator.next()).value, "one");

    // Hold the stream far past the window without pulling, as a consumer blocked on a slow stdout does. No window runs while a line is out with the consumer.
    clock.advance(DOWNLOAD_STALL_MS * 10);
    await settle();

    // The next pull finds "two" waiting on a possible paired terminator and reads on, and the server answers inside the window.
    const next = iterator.next();

    await settle();
    server.download()?.push("three\n");

    assert.equal((await next).value, "two", "a consumer that held the stream must find the download still alive");
    assert.equal(server.signal()?.aborted, false, "holding the stream must never abort the request");

    await iterator.return?.();
  });

  test("completes a slow download whose every wait falls inside the window, and leaves no timer behind", async () => {

    const clock = new TestClock();
    const server = quietServer();
    const lines = collect({ ...TARGET, clock, fetch: server.fetch });

    // Feed the body one line at a time, each arriving just inside the window, so the download as a whole runs several windows long. Each step has to let the download
    // reach its next read before the clock moves, so the steps run in order.
    for(const line of [ "one", "two", "three" ]) {

      // eslint-disable-next-line no-await-in-loop
      await settle();
      clock.advance(DOWNLOAD_STALL_MS - 1);
      server.download()?.push(line + "\n");
    }

    await settle();
    server.download()?.close();

    assert.deepEqual(await lines, [ "one", "two", "three" ], "a download whose every wait falls inside the window must complete");
    assert.equal(clock.advanceToNext(), false, "a finished download must leave no stall timer armed");
  });
});
