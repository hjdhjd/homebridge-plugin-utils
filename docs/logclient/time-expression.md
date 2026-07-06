[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / logclient/time-expression

# logclient/time-expression

Pure, CLI-layer parsing of the `hblog` `--since`/`--until` time expressions into an absolute epoch interval.

[parseTimeExpression](#parsetimeexpression) turns a user-typed expression (`1d`, `7am`, `2026-06-29`, `"2026-06-29 6am"`, `now`/`today`/`yesterday`) into the `{ start, end }` interval
the precision of the expression names. The lower edge (`start`) is what `--since` binds to and the upper edge (`end`) is what `--until` binds to, which is the whole
point of returning an INTERVAL rather than a single instant: a date-only `--until 2026-06-29` then includes the entire named day (its `end` is the last millisecond of
that day), while `--since 2026-06-29` starts at midnight (its `start`).

The module lives at the CLI layer, exactly like `config.ts`: it is isolated, unit-tested against an injected `now`, and NOT part of the package barrel. It takes the
resolved `now` (epoch milliseconds) as an argument rather than reading the clock itself, so resolution is deterministic under test. It is Node-native and depends on no
date library (a house rule); the only shared dependency is [normalizeClock](parser.md#normalizeclock) in `parser.ts`, which owns the 12-hour-to-24-hour clock rule so this module does not
re-implement it. DST-gap instants are best-effort, in the same spirit as `parseLogTimestamp`.

## Log Client

### parseTimeExpression()

```ts
function parseTimeExpression(expr, now): Nullable<{
  end: number;
  start: number;
}>;
```

Parse a `--since`/`--until` time expression into the absolute epoch interval it denotes, resolved against the injected `now`.

The expression is matched in precedence order, first match wins (named tokens and the meridiem are case-insensitive):

1. A named token - `now` (a point), `today` (the whole local day), `yesterday` (the whole prior local day).
2. A relative age - one-or-more `<int><unit>` segments (`1d`, `2h`, `30m`, `90s`, `2h30m`), as `now - sum`; a bare unit-less integer does not match.
3. A `YYYY-MM-DD` date with an optional clock (`2026-06-29`, `2026-06-29T06:00`, `2026-06-29 06:00:00`, `"2026-06-29 6am"`); date-only spans the whole local day.
4. A standalone clock applied to NOW's local date (`7am`, `2pm`, `14:30`, `7:00:00`); a future clock is not rolled back, matching journalctl.

The returned interval's lower edge (`start`) is what `--since` binds to and its upper edge (`end`) is what `--until` binds to, so the precision of the expression
decides how much of a named day or second a bound covers. Returns `null` for any unrecognized or out-of-range input; the CLI maps `null` to a usage error listing the
accepted forms.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `expr` | `string` | The user-typed time expression. |
| `now` | `number` | The reference instant in epoch milliseconds, against which named, relative, and clock-today expressions resolve. |

#### Returns

[`Nullable`](../util.md#nullable)\<\{
  `end`: `number`;
  `start`: `number`;
\}\>

The `{ start, end }` epoch-millisecond interval the expression denotes, or `null` when the expression is not recognized.
