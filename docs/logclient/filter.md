[**homebridge-plugin-utils**](../README.md)

***

[Home](../README.md) / logclient/filter

# logclient/filter

Pure [LogRecord](types.md#logrecord) filter construction.

[createLogFilter](#createlogfilter) compiles a set of optional criteria - a substring/regex grep, a level allow-list, a plugin allow-list - into a single predicate a consumer
folds over any record stream. The module is deliberately I/O-free and warning-free: it owns matching logic only. The orchestration layer is responsible for the
user-facing "a level filter is active but no record carried a level" advisory (a level filter is only meaningful when the Homebridge process emits ANSI color), which
is a policy concern that does not belong in a pure predicate.

An empty criteria set compiles to a pass-all predicate, so a consumer can always build a filter and apply it unconditionally rather than branching on "are any filters
active." Multiple criteria combine with AND - a record must satisfy every active criterion to pass.

## Log Client

### LogFilterCriteria

The filter criteria. Every field is optional; an omitted field imposes no constraint, and an all-omitted object yields a pass-all predicate.

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="grep"></a> `grep?` | `readonly` | `RegExp` | A regular expression tested against the record's ANSI-stripped `message`. A record passes the grep criterion when its message matches. |
| <a id="levels"></a> `levels?` | `readonly` | readonly [`LogLevel`](types.md#loglevel)[] | An allow-list of severity levels. A record passes when its `level` is in the list. A record whose `level` is `null` never satisfies a non-empty level allow-list, since an unknown severity cannot be affirmatively matched against a requested one. |
| <a id="plugins"></a> `plugins?` | `readonly` | readonly `string`[] | An allow-list of plugin names, matched case-insensitively against the record's `plugin`. A record whose `plugin` is `null` never satisfies a non-empty plugin allow-list. |

***

### createLogFilter()

```ts
function createLogFilter(criteria?): (record) => boolean;
```

Compile filter criteria into a single predicate over [LogRecord](types.md#logrecord).

The returned predicate evaluates each active criterion and returns `true` only when all of them pass (logical AND). Criteria are normalized once at construction - the
plugin allow-list is lower-cased into a `Set` for O(1) case-insensitive membership, and the level allow-list into a `Set` - so the per-record hot path does no
repeated allocation or case folding. An all-omitted (or all-empty) criteria object compiles to a predicate that always returns `true`.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `criteria` | [`LogFilterCriteria`](#logfiltercriteria) | The filter criteria. See [LogFilterCriteria](#logfiltercriteria). |

#### Returns

A predicate that returns `true` when a record satisfies every active criterion.

(`record`) => `boolean`
