/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * logclient/rest.test.ts: Unit tests for the streamed whole-file log download - line splitting via the shared splitter, the end-of-response flush, and the 400 mapping.
 */
import { describe, test } from "node:test";
import type { DownloadLogOptions } from "./rest.ts";
import assert from "node:assert/strict";
import { downloadLog } from "./rest.ts";

// The connection target plus token every test reuses. The download flow builds `http://localhost:8581/api/platform-tools/hb-service/log/download?colour=yes`.
const TARGET = { host: "localhost", port: 8581, token: "raw.jwt" };

// A captured fetch call: the request init and the URL string the download flow produced.
interface FetchCall {

  init: RequestInit | undefined;
  url: string;
}

// Build a `fetch` seam double that captures the request and returns a caller-supplied response. The captured call lets a test assert the URL, the colour=yes query, and
// the Authorization header.
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
