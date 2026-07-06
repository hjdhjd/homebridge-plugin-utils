[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / logclient/rest

# logclient/rest

Streamed REST log retrieval for the Homebridge UI log client.

[downloadLog](#downloadlog) fetches the entire log file from `GET /api/platform-tools/hb-service/log/download?colour=yes` and yields it line by line as an
`AsyncIterable<string>` of raw lines (ANSI escapes intact). The server has no range/tail parameter - it always streams the whole file - so this is the deep-history
channel paid only when the user explicitly asks for history beyond the socket's ~500-line seed (see the cost model on `TailRequest` in `types.ts`).

Two details are load-bearing:

- The response body is streamed, not buffered. We feed each chunk through the shared [LogLineSplitter](parser.md#loglinesplitter) so a multi-MB log never has to be materialized in memory
  as one string, and the consumer can begin processing lines as they arrive. The splitter handles lines split across chunk boundaries and the mixed newline
  conventions transparently.
- We MUST call `splitter.flush()` at end-of-response. The splitter withholds a chunk-final lone line-feed pending a possible split `\n\r`/`\r\n` pair in the next
  chunk; at end-of-response no next chunk arrives, so without a flush the final line of the file would be stranded in the carry and silently lost.

The transport asks for `colour=yes` (the raw file with ANSI intact) rather than `colour=no`, because the server's color stripping shifts byte offsets and, more
importantly, the ANSI color IS the severity-level signal the parser reads. When the log method is `systemd`/`custom` the endpoint returns 400; we map that to a clear
"no log file on disk; use --follow" error rather than surfacing a bare HTTP status.

The `fetch` implementation is injected (defaulting to the global `fetch`) so the whole flow is exercised in tests without a live server.

## Log Client

### DownloadLogOptions

Options accepted by [downloadLog](#downloadlog): the connection target plus the raw token, an injectable `fetch` seam, and an optional abort signal.

#### Extends

- [`SocketTarget`](endpoints.md#sockettarget)

#### Properties

| Property | Modifier | Type | Description | Inherited from |
| ------ | ------ | ------ | ------ | ------ |
| <a id="fetch"></a> `fetch?` | `readonly` | \{ (`input`, `init?`): [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`Response`\>; (`input`, `init?`): [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`Response`\>; \} | The fetch implementation to use. Defaults to the global `fetch`. Injected so the download flow is testable without a live server. | - |
| <a id="host"></a> `host` | `readonly` | `string` | The hostname or IP of the homebridge-config-ui-x server. | [`SocketTarget`](endpoints.md#sockettarget).[`host`](endpoints.md#host-1) |
| <a id="port"></a> `port` | `readonly` | `number` | The TCP port the server listens on. | [`SocketTarget`](endpoints.md#sockettarget).[`port`](endpoints.md#port-1) |
| <a id="signal"></a> `signal?` | `readonly` | [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) | Optional abort signal forwarded to the underlying `fetch`. When it aborts, the in-flight request and the body reader are both cancelled so the connection is released immediately rather than draining to completion in the background. A pre-aborted signal short-circuits the download before any request is made (the platform `fetch` rejects synchronously). | - |
| <a id="tls"></a> `tls?` | `readonly` | `boolean` | When `true`, use the secure (`https`) scheme; when `false` or omitted, plaintext (`http`). | [`SocketTarget`](endpoints.md#sockettarget).[`tls`](endpoints.md#tls-1) |
| <a id="token"></a> `token` | `readonly` | `string` | The raw bearer token, sent as `Authorization: Bearer <token>`. | [`SocketTarget`](endpoints.md#sockettarget).[`token`](endpoints.md#token) |

***

### downloadLog()

```ts
function downloadLog(options): AsyncIterable<string>;
```

Download the entire Homebridge log file over REST and yield it as raw lines.

Streams `GET /api/platform-tools/hb-service/log/download?colour=yes` through the shared [LogLineSplitter](parser.md#loglinesplitter), yielding each raw line (ANSI intact) as it becomes
available, and flushing the splitter at end-of-response so the file's final line is never stranded. The whole-file download is the deep-history channel: the server
exposes no tail/range parameter, so a caller that only wants the most recent N lines drains this iterable and retains the tail (e.g., via `takeLast`).

When `options.signal` is supplied, the download is abortable: aborting the signal cancels the in-flight `fetch` and the body reader so the connection is released
immediately rather than draining in the background, and a pre-aborted signal short-circuits before any request is made. This is what lets the windowed hedge supersede
a speculative deep-history download the moment the socket seed is shown to cover the window.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`DownloadLogOptions`](#downloadlogoptions) | The connection target, the raw token, the injectable `fetch` seam, and the optional abort signal. See [DownloadLogOptions](#downloadlogoptions). |

#### Returns

`AsyncIterable`\<`string`\>

An async iterable of raw log lines (escapes intact, terminators removed), in file order.

#### Throws

`Error` when the server returns a 400 (the log method is not file-backed, so there is no file to download - the message advises `--follow`), or any other
        non-2xx status, or when the response carries no body. Propagates `options.signal`'s reason (typically an `HbpuAbortError`) when the signal aborts.
