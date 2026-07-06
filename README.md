<SPAN ALIGN="CENTER" STYLE="text-align:center">
<DIV ALIGN="CENTER" STYLE="text-align:center">

# Homebridge Plugin Utilities
[![Downloads](https://img.shields.io/npm/dt/homebridge-plugin-utils?color=%23491F59&logo=icloud&logoColor=%23FFFFFF&style=for-the-badge)](https://www.npmjs.com/package/homebridge-plugin-utils)
[![Version](https://img.shields.io/npm/v/homebridge-plugin-utils?color=%23491F59&label=Latest%20Version&logo=homebridge&logoColor=%23FFFFFF&style=for-the-badge)](https://www.npmjs.com/package/homebridge-plugin-utils)
[![Homebridge Discord](https://img.shields.io/discord/432663330281226270?color=%23491F59&label=Discord&logo=discord&logoColor=%23FFFFFF&style=for-the-badge)](https://discord.gg/QXqfHEW)
</DIV>
</SPAN>

`homebridge-plugin-utils` is a utility library for [Homebridge](https://homebridge.io) [plugins](https://developers.homebridge.io) that aims to provide a set of common core capabilities that can accelerate and streamline plugin development. It's opinionated and largely derived from my other plugins and my desire to increase code reuse and make it easier to provide rich capabilities across all my plugins so that each of my plugins can focus on providing their unique capabilities rather than copying over the same capabilities (feature options, MQTT support, and a rich webUI interface to name a few) time after time.

The design decisions are driven by my own needs as I continue to create, evolve, and maintain my plugins but I also wanted to provide these as a resource to others, should it be of interest.

### Features

- **Feature options.** Feature options are a hierarchical configuration system and matching webUI that allows users to set global defaults and override them at a granular level, enabling easier mass-customization of capabilities. For plugins that can potentially enumerate dozens of devices, this comes in quite handy so you don't need to configure each and every device, and instead you can focus on the exceptions.

- **Configuration webUI.** This a rich, custom webUI for enumerating all the devices a plugin knows about, and configuring feature options.

- **FFmpeg process utilities.** A rich set of classes that abstract away the complexity of FFmpeg and have builtin capabilities to enable livestreaming, HomeKit Secure Video (HKSV) event recording, and more. Includes hardware acceleration support among it's many features.

- **MQTT client.** Building in MQTT client capabilities is made easier through a set of utilities that allow you to easily publish and subscribe to events.

- **`hblog` log client.** A zero-dependency tool for tailing and querying a `homebridge-config-ui-x` log, usable both as the `hblog` command-line bin and as the importable `HomebridgeLogClient` API. See [Log Client (`hblog`)](#log-client-hblog) below.

- **Plugin tooling.** A `homebridge-plugin-utils` command-line tool that mirrors the compiled webUI into your plugin under a content-hashed folder (so the browser never serves a stale copy after a rebuild) and regenerates your Feature Options reference from its catalog (so the docs can't drift). See [Plugin Tooling (`prepare-ui` and `prepare-docs`)](#plugin-tooling-prepare-ui-and-prepare-docs) below.

- **And more...**

## Documentation

Documentation and examples for using this library to simplify and enhance Homebridge plugin development, especially camera-related plugins, is [available here](https://github.com/hjdhjd/homebridge-plugin-utils/blob/main/docs/README.md). Additionally, if you'd like to see this library being used in a well-documented, real-world example, please take a good look at my [homebridge-unifi-protect](https://github.com/hjdhjd/homebridge-unifi-protect) project. It relies heavily on this library for much of the functionality it provides.

## Log Client (`hblog`)

`hblog` is a zero-dependency tool for tailing and querying the log of a [homebridge-config-ui-x](https://github.com/homebridge/homebridge-config-ui-x) instance. It connects to the web UI, authenticates, and either live-tails the log over the UI's Socket.IO stream or pulls historical lines over REST. It is meant for plugin development and debugging.

It is available two ways: as the `hblog` command-line bin, and as the importable `HomebridgeLogClient` API.

### Command line

```
hblog [filters] [options]

Connection:
  --host <host>          The homebridge-config-ui-x host (default: localhost).
  --port <port>          The server port (default: 8581).
  --tls                  Connect over TLS (https/wss).
  --user <username>      The login username.
  --pass <password>      The login password.
  --token <token>        A pre-acquired bearer token (used verbatim).
  --otp <code>           A one-time passcode for a 2FA-enabled account.

Mode:
  -f, --follow           Live-tail the log (default).
  -n, --lines <N>        Retrieve the most recent N lines.
  --all                  Retrieve the entire log (cannot be combined with -n).

Filters:
  -p, --plugin <name>    Only show lines from this plugin (repeatable).
  -g, --grep <regex>     Only show lines whose message matches this regular expression.
  -l, --level <level>    Only show lines at this level: debug, error, info, success, warn (repeatable).

Output:
  --json                 Emit one JSON record per line (NDJSON).
  --raw                  Emit raw lines with ANSI escapes preserved.
  --no-color             Strip ANSI escapes from the output.
  --version              Print the hblog version and exit.
  -h, --help             Print this help and exit.
```

Bare `hblog` live-tails the log. `--follow` rides the UI's Socket.IO stream - it is cheap and incremental, includes a free ~500-line seed of recent history, and reconnects automatically through the Homebridge restarts you do while iterating. A deep `-n N` or `--all` falls back to a one-shot whole-file download, paid only when you explicitly ask for history beyond the seed. `history`/`--all` require the Homebridge log method to be file-backed (`file`/`native`); with `systemd`/`custom` there is no file to download, so use `--follow` instead.

Output discipline is pipe-friendly: log data goes to stdout (so `--json` NDJSON stays clean), diagnostics and warnings go to stderr, and a broken downstream pipe (`hblog -f | grep -m1 ...`) ends cleanly. Exit codes are `0` for success (including a clean Ctrl-C), `1` for a connection or authentication failure, and `2` for a usage error.

### `~/.hblog.json`

Connection settings are resolved with the precedence flags > environment > config file > defaults. The environment variables are `HBLOG_HOST`, `HBLOG_PORT`, `HBLOG_USER`, `HBLOG_PASS`, `HBLOG_TOKEN`, and `HBLOG_OTP`. The optional config file lives at `~/.hblog.json` (override the path with `HBLOG_CONFIG`) and carries any subset of these keys:

```json
{
  "host": "localhost",
  "port": 8581,
  "tls": false,
  "username": "admin",
  "password": "your-password",
  "token": "a-pre-acquired-bearer-token"
}
```

A missing file is silent, a malformed file is a clear error, and unknown keys are ignored. The file has no `otp` key on purpose - a one-time passcode is single-use and time-bound, so it only ever comes from `--otp` or `HBLOG_OTP`.

> **Credential security.** `~/.hblog.json` may store a password or a long-lived token in plaintext. Restrict it to your account with `chmod 600 ~/.hblog.json`; `hblog` prints a one-line warning if the file is readable by group or other. Tokens are never logged, and any token embedded in a URL or error message is redacted before it is printed.

### `FORCE_COLOR` and level filtering

In `homebridge-config-ui-x`, a log line's severity is conveyed only by its ANSI color, not by a textual label - and that color is usually absent when Homebridge runs under hb-service/systemd. Reliable `--level` filtering therefore requires color to be present: set `FORCE_COLOR=1` on the **Homebridge process** so it emits colored output. When a `--level` filter is active but the lines carry no color, `hblog` warns once and passes lines through unfiltered by level rather than producing silent empty output.

### Programmatic use

```ts
import { HomebridgeLogClient } from "homebridge-plugin-utils";

await using client = new HomebridgeLogClient({ credentials: { kind: "password", password: "secret", username: "admin" }, host: "localhost" });

await using stream = client.tail({ mode: "follow-history", quantity: 200 });

for await (const record of stream) {

  process.stdout.write(record.raw + "\n");
}
```

`HomebridgeLogClient` is `AsyncDisposable`: `await using` (or an early `break` out of the iteration) tears the underlying transport down with no leak. Its three channels - `history()`, `follow()`, and `tail()` - each return a `LogStream` of parsed `LogRecord`s. Filtering is consumer-composed via `createLogFilter` over any stream.

## Plugin Tooling (`prepare-ui` and `prepare-docs`)

Installing this library also installs a `homebridge-plugin-utils` command-line tool that automates the two build steps every consuming plugin needs: mirroring the compiled webUI into the plugin, and keeping the Feature Options reference in sync with the catalog. Both are meant to run from a plugin's `build` or `prepublishOnly` script so neither artifact can drift from the source.

```
Usage: homebridge-plugin-utils <command> [options]

Commands:
  prepare-ui <destination>                          Mirror HBPU's webUI into the plugin's lib directory.
  prepare-docs <catalog-module> [--doc <path>]      Generate the Feature Options reference into the plugin's docs.
```

- **`prepare-ui <destination>`** mirrors this library's compiled browser-side webUI into your plugin's UI directory (typically `homebridge-ui/public/lib`) under a content-hashed, version-named subfolder. Because the folder name changes whenever its contents change, the browser's HTTP cache invalidates structurally - you never have to chase a stale cached copy after a rebuild. The run is idempotent and sweeps away the previous build's subfolder in the same pass, while leaving any non-versioned files in the destination untouched.

- **`prepare-docs <catalog-module> [--doc <path>]`** regenerates your plugin's Feature Options reference straight from its options catalog, splicing it into a marked region of the target document - `docs/FeatureOptions.md` by default, or the `--doc` path you pass for a plugin that ships its reference elsewhere. Running it on every build keeps the published reference from drifting away from the options you actually ship.

## Lint Configuration

Plugins that extend `homebridge-plugin-utils/eslint` automatically inherit a small set of in-house ESLint rules under the `@hjdhjd` namespace. Most are stylistic warnings; one (`@hjdhjd/comment-style`) is an enforcement rule wired at error severity to keep comments grep-able and rendering-stable across editors, terminals, diff tools, and review UIs.

### `@hjdhjd/comment-style`

The rule walks every `//` and `/* */` comment in a single pass and reports four classes of drift. Each class autofixes mechanically under `eslint --fix`.

| Group | Pattern | Autofix |
|---|---|---|
| A | Unicode glyphs with direct ASCII equivalents: left-right arrow (U+2194), rightwards arrow (U+2192), leftwards arrow (U+2190), less-than-or-equal (U+2264), greater-than-or-equal (U+2265), plus-minus (U+00B1) | Substituted with `<->`, `->`, `<-`, `<=`, `>=`, `+/-` respectively |
| B | Em-dash (U+2014) | Substituted with a regular hyphen `-` |
| C | Decorative banner separators in line comments: runs of four or more `=`, `-`, or `#` on a line by themselves | The entire offending source line is removed, including its trailing newline |
| D | Box-drawing characters: the full Unicode Box Drawing block (U+2500..U+257F), covering both single-line and double-line forms | The offending characters are stripped from the comment |

The rule is comment-scoped by construction. It walks the AST's comment list and cannot touch string literals, template positions, or identifier names, so a webUI label that legitimately renders an arrow to the user, or a test fixture exercising em-dash rendering, is never affected.

For the rare case where a comment must contain one of these characters - documentation that quotes a banned glyph by name, a unit test for the rule itself, or a generated comment that references an external character set - use ESLint's standard inline disable directive on the line above:

```js
// eslint-disable-next-line @hjdhjd/comment-style
// Renders the user-visible right-arrow glyph: →
```

For multiple consecutive lines, wrap the region with `/* eslint-disable @hjdhjd/comment-style */` and `/* eslint-enable @hjdhjd/comment-style */` block directives.

## Plugin Development Dashboard
This is mostly of interest to the true developer nerds amongst us.

[![License](https://img.shields.io/npm/l/homebridge-plugin-utils?color=%23491F59&logo=open%20source%20initiative&logoColor=%23FFFFFF&style=for-the-badge)](https://github.com/hjdhjd/homebridge-plugin-utils/blob/main/LICENSE.md)
[![Build Status](https://img.shields.io/github/actions/workflow/status/hjdhjd/homebridge-plugin-utils/ci.yml?branch=main&color=%23491F59&logo=github-actions&logoColor=%23FFFFFF&style=for-the-badge)](https://github.com/hjdhjd/homebridge-plugin-utils/actions?query=workflow%3A%22Continuous+Integration%22)
[![Dependencies](https://img.shields.io/librariesio/release/npm/homebridge-plugin-utils?color=%23491F59&logo=dependabot&style=for-the-badge)](https://libraries.io/npm/homebridge-plugin-utils)
[![GitHub commits since latest release (by SemVer)](https://img.shields.io/github/commits-since/hjdhjd/homebridge-plugin-utils/latest?color=%23491F59&logo=github&sort=semver&style=for-the-badge)](https://github.com/hjdhjd/homebridge-plugin-utils/commits/main)
