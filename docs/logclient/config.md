[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / logclient/config

# logclient/config

CLI-layer configuration for the `hblog` tool: loading the optional `~/.hblog.json` file and the pure merge of file / environment / flags into a connection.

This module lives at the CLI layer on purpose: the engine ([HomebridgeLogClient](client.md#homebridgelogclient) and its transports) never reads the
user's home directory or any config file - all file I/O stays here, behind injectable seams, so the engine is portable and side-effect-free. This module exports the
following pieces:

- [resolveConfigPath](#resolveconfigpath) - resolve the absolute config-file path, honoring the `HBLOG_CONFIG` environment override over the home-directory default
  ([DEFAULT\_CONFIG\_FILENAME](#default_config_filename)).
- [loadConfigFile](#loadconfigfile) - read and parse the optional `~/.hblog.json`. A missing file resolves to `undefined` silently (the file is optional); a malformed file raises
  a clear, actionable error; unknown keys are ignored; and a file whose permissions are group/other-readable triggers a single one-line warning recommending `chmod
  600`, because the file may carry a password or a long-lived token in plaintext. The `readFile`, `stat`, and `warn` seams are injected so the loader is unit-tested
  without touching the real filesystem.
- [resolveConnection](#resolveconnection) - a PURE merge of the configuration sources into one resolved connection, applying the precedence flags > environment > file > defaults.
  It performs no I/O of its own; the caller supplies the already-loaded file, the environment slice, and the parsed flags.

## Log Client

### HblogConfigFile

The shape of the optional `~/.hblog.json` config file. Every field is optional; unknown keys in the file are ignored. The file deliberately carries no `otp` field - a
one-time passcode is, by definition, single-use and time-bound, so it only ever comes from the `--otp` flag or the `HBLOG_OTP` environment variable, never from a
persisted file.

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="host"></a> `host?` | `readonly` | `string` | The hostname or IP of the homebridge-config-ui-x server. |
| <a id="password"></a> `password?` | `readonly` | `string` | The account password, for username/password authentication. |
| <a id="port"></a> `port?` | `readonly` | `number` | The TCP port the server listens on. |
| <a id="tls"></a> `tls?` | `readonly` | `boolean` | Whether to use the secure (`https`/`wss`) schemes. |
| <a id="token"></a> `token?` | `readonly` | `string` | A pre-acquired bearer token, used verbatim. |
| <a id="username"></a> `username?` | `readonly` | `string` | The account username, for username/password authentication. |

***

### HblogConnectionFlags

The command-line connection flags consulted by [resolveConnection](#resolveconnection). These are the parsed `--host`, `--port`, `--tls`, `--user`, `--pass`, `--token`, and `--otp`
values. They take the highest precedence in the merge.

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="host-1"></a> `host?` | `readonly` | `string` | The `--host` value. |
| <a id="otp"></a> `otp?` | `readonly` | `string` | The `--otp` value. |
| <a id="password-1"></a> `password?` | `readonly` | `string` | The `--pass` value. |
| <a id="port-1"></a> `port?` | `readonly` | `number` | The `--port` value (already parsed to a number by the flag parser, or omitted). |
| <a id="tls-1"></a> `tls?` | `readonly` | `boolean` | The `--tls` value. |
| <a id="token-1"></a> `token?` | `readonly` | `string` | The `--token` value. |
| <a id="username-1"></a> `username?` | `readonly` | `string` | The `--user` value. |

***

### HblogEnv

The environment-variable slice consulted by [resolveConnection](#resolveconnection). The CLI reads these from `process.env` (`HBLOG_HOST`, `HBLOG_PORT`, `HBLOG_USER`, `HBLOG_PASS`,
`HBLOG_TOKEN`, `HBLOG_OTP`) and passes them here as already-extracted values so the resolver itself touches no globals.

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="host-2"></a> `host?` | `readonly` | `string` | The `HBLOG_HOST` value. |
| <a id="otp-1"></a> `otp?` | `readonly` | `string` | The `HBLOG_OTP` value (a one-time passcode). |
| <a id="password-2"></a> `password?` | `readonly` | `string` | The `HBLOG_PASS` value. |
| <a id="port-2"></a> `port?` | `readonly` | `string` | The `HBLOG_PORT` value (still a string here; parsed during resolution). |
| <a id="token-2"></a> `token?` | `readonly` | `string` | The `HBLOG_TOKEN` value. |
| <a id="username-2"></a> `username?` | `readonly` | `string` | The `HBLOG_USER` value. |

***

### LoadConfigFileOptions

Options accepted by [loadConfigFile](#loadconfigfile): the injectable filesystem and warning seams. All default to the real Node implementations / a `process.stderr` writer, so a
caller (the CLI) can omit them in production and a test can supply doubles.

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="readfile"></a> `readFile?` | `readonly` | (`path`) => [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<`string`\> | Reads the file's UTF-8 text. Defaults to `node:fs/promises` `readFile`. A rejection whose `code` is `ENOENT` is treated as "file absent." |
| <a id="stat"></a> `stat?` | `readonly` | (`path`) => [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<\{ `mode`: `number`; \}\> | Stats the file for its permission mode. Defaults to `node:fs/promises` `stat`. Used only for the group/other-readable security warning. |
| <a id="warn"></a> `warn?` | `readonly` | (`message`) => `void` | Sink for the single one-line security warning. Defaults to a `process.stderr` writer. Injected so a test asserts the warning without capturing real stderr. |

***

### ResolvedConnection

The fully-resolved connection produced by [resolveConnection](#resolveconnection): the connection target plus the credential material the CLI uses to build a
[LogClientCredentials](types.md#logclientcredentials) discriminated union. `host`, `port`, and `tls` always carry a concrete value (defaults applied);
the credential fields are [Nullable](../util.md#nullable) because none, some, or all of them may have been supplied across the three sources.

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="host-3"></a> `host` | `readonly` | `string` | The resolved hostname or IP. |
| <a id="otp-2"></a> `otp` | `readonly` | [`Nullable`](../util.md#nullable)\<`string`\> | The resolved one-time passcode, or `null` when none was supplied. |
| <a id="password-3"></a> `password` | `readonly` | [`Nullable`](../util.md#nullable)\<`string`\> | The resolved password, or `null` when none was supplied. |
| <a id="port-3"></a> `port` | `readonly` | `number` | The resolved TCP port. |
| <a id="tls-2"></a> `tls` | `readonly` | `boolean` | The resolved TLS flag. |
| <a id="token-3"></a> `token` | `readonly` | [`Nullable`](../util.md#nullable)\<`string`\> | The resolved bearer token, or `null` when none was supplied. |
| <a id="username-3"></a> `username` | `readonly` | [`Nullable`](../util.md#nullable)\<`string`\> | The resolved username, or `null` when none was supplied. |

***

### loadConfigFile()

```ts
function loadConfigFile(path, options?): Promise<HblogConfigFile | undefined>;
```

Load and parse the optional `~/.hblog.json` config file.

The file is optional: when it does not exist (ENOENT) this resolves to `undefined` silently. Every other failure is thrown as a clear, actionable error naming the
path: a non-ENOENT read failure (a permission or I/O fault), a file that cannot be parsed as JSON, or a file whose top-level value is not a JSON object. Recognized
keys ([HblogConfigFile](#hblogconfigfile)) are picked out by type (a wrong-typed field is ignored, not coerced); any unknown key is ignored. As a security courtesy, if the file's
permissions allow group or other access (`mode & 0o077`), a single one-line warning recommending `chmod 600` is emitted through the `warn` seam, because the file may
store a password or a long-lived token in plaintext.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `path` | `string` | The absolute path of the config file to load (the CLI resolves `~/.hblog.json`, or honors `HBLOG_CONFIG`). |
| `options` | [`LoadConfigFileOptions`](#loadconfigfileoptions) | The injectable filesystem and warning seams. See [LoadConfigFileOptions](#loadconfigfileoptions). |

#### Returns

[`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)\<[`HblogConfigFile`](#hblogconfigfile) \| `undefined`\>

The parsed [HblogConfigFile](#hblogconfigfile), or `undefined` when the file is absent (ENOENT).

#### Throws

`Error` when the file exists but cannot be read (a non-ENOENT read failure), contains malformed JSON, or whose top-level value is not a JSON object.

***

### resolveConfigPath()

```ts
function resolveConfigPath(sources): string;
```

Resolve the absolute path of the config file to load.

The `HBLOG_CONFIG` environment variable overrides everything when set to a non-empty value (handy for tests and non-standard layouts); otherwise the default
[DEFAULT\_CONFIG\_FILENAME](#default_config_filename) (`.hblog.json`) under the supplied home directory is used. Home-dir only - there is no project-local config file, so a config carrying
a password or token is never tempting to commit alongside a plugin's source. The join uses a single forward slash, which both POSIX and Windows accept in a path passed
to `readFile`, so no `node:path` import is needed on this hot setup path.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `sources` | \{ `env`: `ProcessEnv`; `homedir`: `string`; \} | The path inputs. |
| `sources.env` | `ProcessEnv` | The environment map; only `HBLOG_CONFIG` is consulted. |
| `sources.homedir` | `string` | The user's home directory, the anchor for the default config-file path. |

#### Returns

`string`

The absolute path to load the config file from.

***

### resolveConnection()

```ts
function resolveConnection(sources): ResolvedConnection;
```

Resolve the three configuration sources into a single [ResolvedConnection](#resolvedconnection), applying the precedence flags > environment > file > defaults.

This is a PURE function: it reads only its arguments and allocates only the result, performing no I/O. The caller is responsible for having loaded the file (via
[loadConfigFile](#loadconfigfile)), extracted the environment slice, and parsed the flags. `host`, `port`, and `tls` always resolve to a concrete value (their defaults are
`localhost`, `8581`, and `false`); the credential fields resolve to `null` when no source supplied them, leaving the CLI to decide which
[LogClientCredentials](types.md#logclientcredentials) arm the resolved material implies. The `port` from the environment is a string, so it is
parsed here; a non-numeric `HBLOG_PORT` is ignored (falls through to the next source) rather than producing a `NaN` port.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `sources` | \{ `env`: [`HblogEnv`](#hblogenv); `file`: [`HblogConfigFile`](#hblogconfigfile) \| `undefined`; `flags`: [`HblogConnectionFlags`](#hblogconnectionflags); \} | The three configuration sources. |
| `sources.env` | [`HblogEnv`](#hblogenv) | The environment slice. See [HblogEnv](#hblogenv). |
| `sources.file` | [`HblogConfigFile`](#hblogconfigfile) \| `undefined` | The loaded config file, or `undefined` when absent. See [HblogConfigFile](#hblogconfigfile). |
| `sources.flags` | [`HblogConnectionFlags`](#hblogconnectionflags) | The parsed command-line flags. See [HblogConnectionFlags](#hblogconnectionflags). |

#### Returns

[`ResolvedConnection`](#resolvedconnection)

The fully-resolved connection.

## Other

### DEFAULT\_CONFIG\_FILENAME

```ts
const DEFAULT_CONFIG_FILENAME: ".hblog.json" = ".hblog.json";
```
