/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * logclient/rest.ts: Streamed whole-file log download from the homebridge-config-ui-x REST API.
 */

/**
 * Streamed REST log retrieval for the Homebridge UI log client.
 *
 * {@link downloadLog} fetches the entire log file from `GET /api/platform-tools/hb-service/log/download?colour=yes` and yields it line by line as an
 * `AsyncIterable<string>` of raw lines (ANSI escapes intact). The server has no range/tail parameter - it always streams the whole file - so this is the deep-history
 * channel paid only when the user explicitly asks for history beyond the socket's ~500-line seed (see the cost model on `TailRequest` in `types.ts`).
 *
 * A few details matter here:
 *
 * - The response body is streamed, not buffered. We feed each chunk through the shared {@link LogLineSplitter} so a multi-MB log never has to be materialized in memory
 *   as one string, and the consumer can begin processing lines as they arrive. The splitter handles lines split across chunk boundaries and the mixed newline
 *   conventions transparently.
 * - We MUST call `splitter.flush()` at end-of-response. The splitter withholds a chunk-final lone line-feed pending a possible split `\n\r`/`\r\n` pair in the next
 *   chunk; at end-of-response no next chunk arrives, so without a flush the final line of the file would be stranded in the carry and silently lost.
 * - A silent server fails the download rather than holding it open. Each wait on the server - for the response to begin, and for every read of its body - is bounded by
 *   `DOWNLOAD_STALL_MS` through one {@link Watchdog}, so a transfer that stops partway surfaces as an actionable error instead of an open-ended hang. Only those waits
 *   are bounded: while a line is out with the consumer no window runs, so a slow reader downstream is never mistaken for a stalled server.
 *
 * The transport asks for `colour=yes` (the raw file with ANSI intact) rather than `colour=no`, because the server's color stripping shifts byte offsets, and the ANSI
 * color IS the severity-level signal the parser reads. When the log method is `systemd`/`custom` the endpoint returns 400; we map that to a clear "no log file on
 * disk; use --follow" error rather than surfacing a bare HTTP status.
 *
 * The `fetch` implementation is injected (defaulting to the global `fetch`) so the whole flow is exercised in tests without a live server.
 *
 * @module
 */
import { Watchdog, composeSignals } from "../util.ts";
import type { Clock } from "../clock.ts";
import { DOWNLOAD_STALL_MS } from "./settings.ts";
import { LogLineSplitter } from "./parser.ts";
import type { SocketTarget } from "./endpoints.ts";
import { httpBaseUrl } from "./endpoints.ts";

// The message a download fails with when the server goes silent past the stall bound.
const STALL_MESSAGE = "Log download stalled - the server sent no data for " + (DOWNLOAD_STALL_MS / 1000).toString() + " seconds.";

/**
 * Options accepted by {@link downloadLog}: the connection target plus the raw token, an injectable `fetch` and time source, and an optional abort signal.
 *
 * @property clock  - Optional {@link Clock} the stall bound is armed on. Omitted, the bound runs on real time; a test injects a `TestClock` so a stall is driven by
 *                    advancing virtual time rather than by waiting.
 * @property fetch  - The fetch implementation to use. Defaults to the global `fetch`. Injected so the download flow is testable without a live server.
 * @property host   - The hostname or IP of the homebridge-config-ui-x server.
 * @property port   - The TCP port the server listens on.
 * @property signal - Optional abort signal forwarded to the underlying `fetch`. When it aborts, the in-flight request and the body reader are both cancelled so the
 *                    connection is released immediately rather than draining to completion in the background. A pre-aborted signal short-circuits the download before any
 *                    request is made (the platform `fetch` rejects synchronously).
 * @property tls    - When `true`, use the secure (`https`) scheme; when `false` or omitted, plaintext (`http`).
 * @property token  - The raw bearer token, sent as `Authorization: Bearer <token>`.
 *
 * @category Log Client
 */
export interface DownloadLogOptions extends SocketTarget {

  readonly clock?: Clock;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
}

// Read a streamed response body to completion, decoding and splitting it into raw lines as they arrive, and release the reader whether the stream ends normally or is
// aborted. We hold a single `TextDecoder` across the whole response with `{ stream: true }` so a multi-byte UTF-8 sequence split across two chunks is reassembled
// correctly rather than producing a replacement character at the boundary. The final `decode()` with no argument flushes any trailing partial sequence. `signal` is the
// request's composed signal and `watchdog` the stall bound armed on it. The watchdog runs only across each read, so it measures the server's silence alone: while a
// line is out with the consumer, this generator is suspended at its yield with no window running.
async function *readLines(body: ReadableStream<Uint8Array>, { signal, watchdog }: { signal: AbortSignal; watchdog: Watchdog }): AsyncIterable<string> {

  const splitter = new LogLineSplitter();
  const decoder = new TextDecoder();
  const reader = body.getReader();

  try {

    for(;;) {

      // Bound this wait on the server, and stand the window down the moment the read settles so the consumer's time between reads is never counted.
      watchdog.arm();

      // A single `ReadableStreamDefaultReader` serves only one `read()` at a time, so this await cannot be fanned out across iterations - the loop is sequential by
      // the reader's own contract, not by an avoidable choice.
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();

      watchdog.clear();

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

    // When the download was aborted (the hedge superseded it, the caller tore the stream down, or the stall bound found the server silent), actively cancel the body
    // first so undici aborts the request and the connection is released immediately rather than staying held open while it drains to completion in the background; the
    // cancel's rejection on an already-aborted body is expected, so it is swallowed. In every case release the reader lock - normal completion, an early `break` by the
    // consumer, or a thrown error - so the underlying stream is never left locked.
    if(signal.aborted) {

      void reader.cancel().catch(() => { /* The body is already torn down by the abort, so the cancel rejection is expected and carries no actionable information. */ });
    }

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
 * When `options.signal` is supplied, the download is abortable: aborting the signal cancels the in-flight `fetch` and the body reader so the connection is released
 * immediately rather than draining in the background, and a pre-aborted signal short-circuits before any request is made. This is what lets the windowed hedge supersede
 * a speculative deep-history download the moment the socket seed is shown to cover the window.
 *
 * @param options - The connection target, the raw token, the injectable `fetch` implementation, and the optional abort signal. See {@link DownloadLogOptions}.
 *
 * @returns An async iterable of raw log lines (escapes intact, terminators removed), in file order.
 *
 * @throws `Error` when the server returns a 400 (the log method is not file-backed, so there is no file to download - the message advises `--follow`), or any other
 *         non-2xx status, or when the response carries no body, or when the server sends no data for `DOWNLOAD_STALL_MS` while the download waits on it. Propagates
 *         `options.signal`'s reason (typically an `HbpuAbortError`) when the signal aborts.
 *
 * @category Log Client
 */
export async function *downloadLog(options: DownloadLogOptions): AsyncIterable<string> {

  const fetchImpl = options.fetch ?? fetch;
  const url = httpBaseUrl(options) + "/api/platform-tools/hb-service/log/download?colour=yes";

  // The stall bound's controller, composed under the caller's signal so the request answers to one signal whichever side ends it: the caller's own teardown, or the
  // watchdog finding the server silent. The platform `fetch` rejects a pending wait - for the response or for a body read - with the signal's reason, so a stall
  // surfaces as the actionable error built here rather than as a bare abort.
  const stall = new AbortController();
  const signal = composeSignals(options.signal, stall.signal);

  using watchdog = new Watchdog({ clock: options.clock, onFire: (): void => stall.abort(new Error(STALL_MESSAGE)), signal, timeoutMs: DOWNLOAD_STALL_MS });

  // Bound the wait for the response to begin, then stand the window down once it has; each read of the body arms it afresh.
  watchdog.arm();

  const response = await fetchImpl(url, { headers: { "Authorization": "Bearer " + options.token }, method: "GET", signal });

  watchdog.clear();

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

  yield* readLines(response.body, { signal, watchdog });
}
