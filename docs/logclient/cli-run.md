[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / logclient/cli-run

# logclient/cli-run

The `hblog` command-line logic, written pure-by-injection.

[runHblog](#runhblog) is the whole CLI behavior with none of the process coupling: it takes its argument vector, environment, output streams, working/home directories, and
the filesystem and transport seams as arguments rather than reading them from globals, and it returns the process exit code rather than calling `process.exit`. That
makes the entire flow - argument parsing, `~/.hblog.json` resolution, credential/request mapping, transport orchestration, output formatting, signal handling, and exit
codes - exercisable in tests against captured streams and fake transports, with no live server and no real process signals.

The bin (`cli.ts`) is a thin shell that resolves its own real directory, dynamic-imports this module, and calls [runHblog](#runhblog) with the real `process` streams,
environment, and directories. Everything that can go wrong (a usage error, an auth failure, a broken pipe, a SIGINT) is decided here and reported as an exit code. The
bin records that code on `process.exitCode` and lets the event loop drain - so a piped stdout flushes in full - rather than forcing termination with `process.exit`.

## Log Client

### CliStream

A minimal output-stream surface [runHblog](#runhblog) writes to. Models the subset of a Node `WriteStream` the CLI actually uses: `write` for output, the optional `isTTY`
flag that drives the auto-color decision, and the optional `on`/`off` event hooks used to trap a broken-pipe (`EPIPE`) error and to await `drain` when a write reports
backpressure. The narrow interface keeps a test sink small (a `write` function is enough) while `process.stdout`/`process.stderr` satisfy it structurally.

#### Properties

| Property | Type |
| ------ | ------ |
| <a id="istty"></a> `isTTY?` | `boolean` |
| <a id="off"></a> `off?` | [`CliStreamEventHook`](#clistreameventhook) |
| <a id="on"></a> `on?` | [`CliStreamEventHook`](#clistreameventhook) |
| <a id="write"></a> `write` | (`chunk`) => `boolean` |

***

### CliStreamEventHook()

The event-hook shape [CliStream](#clistream) exposes for the stream events the CLI observes. Modeled as an overloaded call signature - the same shape `EventEmitter.on`/
`off` present - so each event's listener is typed to exactly what that event delivers: `"error"` hands the listener the failing error (an `EPIPE` broken pipe, or a
genuine write fault such as `ENOSPC`), while `"drain"` delivers nothing and merely signals that the writable buffer has fallen back below its high-water mark.

#### Call Signature

```ts
CliStreamEventHook(event, listener): void;
```

The event-hook shape [CliStream](#clistream) exposes for the stream events the CLI observes. Modeled as an overloaded call signature - the same shape `EventEmitter.on`/
`off` present - so each event's listener is typed to exactly what that event delivers: `"error"` hands the listener the failing error (an `EPIPE` broken pipe, or a
genuine write fault such as `ENOSPC`), while `"drain"` delivers nothing and merely signals that the writable buffer has fallen back below its high-water mark.

##### Parameters

| Parameter | Type |
| ------ | ------ |
| `event` | `"drain"` |
| `listener` | () => `void` |

##### Returns

`void`

#### Call Signature

```ts
CliStreamEventHook(event, listener): void;
```

The event-hook shape [CliStream](#clistream) exposes for the stream events the CLI observes. Modeled as an overloaded call signature - the same shape `EventEmitter.on`/
`off` present - so each event's listener is typed to exactly what that event delivers: `"error"` hands the listener the failing error (an `EPIPE` broken pipe, or a
genuine write fault such as `ENOSPC`), while `"drain"` delivers nothing and merely signals that the writable buffer has fallen back below its high-water mark.

##### Parameters

| Parameter | Type |
| ------ | ------ |
| `event` | `"error"` |
| `listener` | (`error`) => `void` |

##### Returns

`void`

***

### RunHblogOptions

Options accepted by [runHblog](#runhblog). Every external dependency the CLI touches is an injected seam, so the whole flow runs deterministically in tests.

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="argv"></a> `argv` | `readonly` | readonly `string`[] | The argument vector (typically `process.argv.slice(2)`). |
| <a id="cwd"></a> `cwd` | `readonly` | `string` | The current working directory. Reserved for future relative-path resolution; the home directory is the config-file anchor today. |
| <a id="env"></a> `env` | `readonly` | `ProcessEnv` | The environment map (typically `process.env`). |
| <a id="fetch"></a> `fetch?` | `readonly` | \{ (`input`, `init?`): [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`Response`\>; (`input`, `init?`): [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`Response`\>; \} | Optional `fetch` seam forwarded to the engine's auth and REST transports. Defaults to the global `fetch`. |
| <a id="homedir"></a> `homedir` | `readonly` | `string` | The user's home directory, used to locate `~/.hblog.json` unless `HBLOG_CONFIG` overrides the path. |
| <a id="now"></a> `now?` | `readonly` | () => `number` | Optional wall-clock epoch source (milliseconds) used to resolve the `--since`/`--until` time-range expressions against a single deterministic instant. Defaults to `systemClock.now`; a test injects a fixed clock so a windowed run's bounds are reproducible. |
| <a id="readfile"></a> `readFile?` | `readonly` | (`path`) => [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`string`\> | Optional file-read seam forwarded to the config loader and used to read the package version. Defaults to `node:fs/promises` `readFile`. |
| <a id="socketfactory"></a> `socketFactory?` | `readonly` | [`LogSocketFactory`](socket.md#logsocketfactory) | Optional socket-factory seam forwarded to the engine, so a test drives the live tail without a WebSocket. Defaults to the real factory. |
| <a id="stat"></a> `stat?` | `readonly` | (`path`) => [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<\{ `mode`: `number`; \}\> | Optional file-stat seam forwarded to the config loader for the permissions warning. Defaults to `node:fs/promises` `stat`. |
| <a id="stderr"></a> `stderr` | `readonly` | [`CliStream`](#clistream) | The diagnostics/warnings stream. Production passes `process.stderr`. |
| <a id="stdout"></a> `stdout` | `readonly` | [`CliStream`](#clistream) | The log-data stream. Production passes `process.stdout`. |

***

### runHblog()

```ts
function runHblog(options): Promise<number>;
```

Run the `hblog` command-line flow and return the process exit code.

Parses [RunHblogOptions.argv](#argv), handles `--help`/`--version` immediately, resolves the connection across flags / environment / `~/.hblog.json` (honoring
`HBLOG_CONFIG`), maps the result into a [LogClientCredentials](types.md#logclientcredentials) and a [TailRequest](types.md#tailrequest), builds a [HomebridgeLogClient](client.md#homebridgelogclient), runs the selected channel,
applies the [createLogFilter](filter.md#createlogfilter) criteria, and writes log data to stdout (NDJSON for `--json`, raw/stripped lines otherwise) while routing diagnostics and warnings
to stderr. A SIGINT/SIGTERM aborts the run cleanly (exit 0); a broken pipe (`EPIPE`) on stdout also ends cleanly (exit 0); a usage error returns 2; a connection or
authentication failure returns 1. Token redaction is applied at the hard-error stderr writes (the setup failure, a captured stdout write error on either the
normal-completion or the catch path, and the streaming catch's generic error); the usage and advisory writes never carry a token.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`RunHblogOptions`](#runhblogoptions) | The injected argument vector, environment, streams, directories, and seams. See [RunHblogOptions](#runhblogoptions). |

#### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`number`\>

The process exit code: 0 success / clean signal / help / version, 1 connection or auth failure, 2 usage error.
