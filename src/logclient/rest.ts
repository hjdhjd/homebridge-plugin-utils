/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * logclient/rest.ts: Streamed whole-file log download from the homebridge-config-ui-x REST API.
 */

/**
 * Streamed REST log retrieval for the Homebridge UI log client.
 *
 * {@link downloadLog} fetches the entire log file from `GET /api/platform-tools/hb-service/log/download?colour=yes` and yields it line by line as an
 * `AsyncIterable<string>` of raw lines (ANSI escapes intact). The server has no range/tail parameter - it always streams the whole file - so this is the deep-history
 * channel paid only when the user explicitly asks for history beyond the socket's ~500-line seed (see the cost model in the plan).
 *
 * Two details are load-bearing:
 *
 * - The response body is streamed, not buffered. We feed each chunk through the shared {@link LogLineSplitter} so a multi-MB log never has to be materialized in memory
 *   as one string, and the consumer can begin processing lines as they arrive. The splitter handles lines split across chunk boundaries and the mixed newline
 *   conventions transparently.
 * - We MUST call `splitter.flush()` at end-of-response. The splitter withholds a chunk-final lone line-feed pending a possible split `\n\r`/`\r\n` pair in the next
 *   chunk; at end-of-response no next chunk arrives, so without a flush the final line of the file would be stranded in the carry and silently lost.
 *
 * The transport asks for `colour=yes` (the raw file with ANSI intact) rather than `colour=no`, because the server's color stripping shifts byte offsets and, more
 * importantly, the ANSI color IS the severity-level signal the parser reads. When the log method is `systemd`/`custom` the endpoint returns 400; we map that to a clear
 * "no log file on disk; use --follow" error rather than surfacing a bare HTTP status.
 *
 * The `fetch` implementation is injected (defaulting to the global `fetch`) so the whole flow is exercised in tests without a live server.
 *
 * @module
 */
import { LogLineSplitter } from "./parser.ts";
import type { SocketTarget } from "./endpoints.ts";
import { httpBaseUrl } from "./endpoints.ts";

/**
 * Options accepted by {@link downloadLog}: the connection target plus the raw token and an injectable `fetch` seam.
 *
 * @property fetch - The fetch implementation to use. Defaults to the global `fetch`. Injected so the download flow is testable without a live server.
 * @property host  - The hostname or IP of the homebridge-config-ui-x server.
 * @property port  - The TCP port the server listens on.
 * @property tls   - When `true`, use the secure (`https`) scheme; when `false` or omitted, plaintext (`http`).
 * @property token - The raw bearer token, sent as `Authorization: Bearer <token>`.
 *
 * @category Log Client
 */
export interface DownloadLogOptions extends SocketTarget {

  readonly fetch?: typeof fetch;
}

// Decode a streamed byte chunk to text. We hold a single `TextDecoder` across the whole response with `{ stream: true }` so a multi-byte UTF-8 sequence split across two
// chunks is reassembled correctly rather than producing a replacement character at the boundary. The final `decode()` with no argument flushes any trailing partial
// sequence.
async function *readLines(body: ReadableStream<Uint8Array>): AsyncIterable<string> {

  const splitter = new LogLineSplitter();
  const decoder = new TextDecoder();
  const reader = body.getReader();

  try {

    for(;;) {

      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();

      if(done) {

        break;
      }

      // Decode this chunk (streaming, so a split multi-byte sequence carries into the next read) and feed it to the splitter, yielding every complete raw line the chunk
      // contained or completed.
      for(const line of splitter.consume(decoder.decode(value, { stream: true }))) {

        yield line;
      }
    }

    // Flush the decoder's trailing partial sequence (if any) into the splitter, then flush the splitter's held final line. The splitter withholds a chunk-final lone
    // line-feed pending a possible cross-chunk pair; at end-of-response no further chunk arrives, so this flush is what surfaces the file's last line rather than
    // stranding it in the carry.
    const tail = decoder.decode();

    if(tail.length > 0) {

      for(const line of splitter.consume(tail)) {

        yield line;
      }
    }

    for(const line of splitter.flush()) {

      yield line;
    }
  } finally {

    // Release the reader lock on every exit path - normal completion, an early `break` by the consumer, or a thrown error - so the underlying stream is not left locked.
    reader.releaseLock();
  }
}

/**
 * Download the entire Homebridge log file over REST and yield it as raw lines.
 *
 * Streams `GET /api/platform-tools/hb-service/log/download?colour=yes` through the shared {@link LogLineSplitter}, yielding each raw line (ANSI intact) as it becomes
 * available, and flushing the splitter at end-of-response so the file's final line is never stranded. The whole-file download is the deep-history channel: the server
 * exposes no tail/range parameter, so a caller that only wants the most recent N lines drains this iterable and retains the tail (e.g., via `takeLast`).
 *
 * @param options - The connection target, the raw token, and the injectable `fetch` seam. See {@link DownloadLogOptions}.
 *
 * @returns An async iterable of raw log lines (escapes intact, terminators removed), in file order.
 *
 * @throws `Error` when the server returns a 400 (the log method is not file-backed, so there is no file to download - the message advises `--follow`), or any other
 *         non-2xx status, or when the response carries no body.
 *
 * @category Log Client
 */
export async function *downloadLog(options: DownloadLogOptions): AsyncIterable<string> {

  const fetchImpl = options.fetch ?? fetch;
  const url = httpBaseUrl(options) + "/api/platform-tools/hb-service/log/download?colour=yes";

  const response = await fetchImpl(url, { headers: { "Authorization": "Bearer " + options.token }, method: "GET" });

  // A 400 from this endpoint means the configured log method is not file-backed (systemd/custom), so there is no file on disk to download. Map it to an actionable
  // message that points the user at the live-tail channel rather than surfacing a bare status code.
  if(response.status === 400) {

    throw new Error("No log file is available to download on disk (the Homebridge log method is not file-backed); use --follow to live-tail instead.");
  }

  if(!response.ok) {

    throw new Error("Log download failed - the server returned HTTP " + response.status.toString() + " (" + response.statusText + ").");
  }

  if(response.body === null) {

    throw new Error("Log download failed - the server returned an empty response body.");
  }

  yield* readLines(response.body);
}
