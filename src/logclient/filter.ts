/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * logclient/filter.ts: Pure predicate builder for filtering parsed log records.
 */

/**
 * Pure {@link LogRecord} filter construction.
 *
 * {@link createLogFilter} compiles a set of optional criteria - a substring/regex grep, a level allow-list, a plugin allow-list - into a single predicate a consumer
 * folds over any record stream. The module is deliberately I/O-free and warning-free: it owns matching logic only. The orchestration layer is responsible for the
 * user-facing "a level filter is active but no record carried a level" advisory (a level filter is only meaningful when the Homebridge process emits ANSI color), which
 * is a policy concern that does not belong in a pure predicate.
 *
 * An empty criteria set compiles to a pass-all predicate, so a consumer can always build a filter and apply it unconditionally rather than branching on "are any filters
 * active." Multiple criteria combine with AND - a record must satisfy every active criterion to pass.
 *
 * @module
 */
import type { LogLevel, LogRecord } from "./types.ts";

/**
 * The filter criteria. Every field is optional; an omitted field imposes no constraint, and an all-omitted object yields a pass-all predicate.
 *
 * @property grep    - A regular expression tested against the record's ANSI-stripped `message`. A record passes the grep criterion when its message matches.
 * @property levels  - An allow-list of severity levels. A record passes when its `level` is in the list. A record whose `level` is `null` never satisfies a non-empty
 *                     level allow-list, since an unknown severity cannot be affirmatively matched against a requested one.
 * @property plugins - An allow-list of plugin names, matched case-insensitively against the record's `plugin`. A record whose `plugin` is `null` never satisfies a
 *                     non-empty plugin allow-list.
 *
 * @category Log Client
 */
export interface LogFilterCriteria {

  readonly grep?: RegExp;
  readonly levels?: readonly LogLevel[];
  readonly plugins?: readonly string[];
}

/**
 * Compile filter criteria into a single predicate over {@link LogRecord}.
 *
 * The returned predicate evaluates each active criterion and returns `true` only when all of them pass (logical AND). Criteria are normalized once at construction - the
 * plugin allow-list is lower-cased into a `Set` for O(1) case-insensitive membership, and the level allow-list into a `Set` - so the per-record hot path does no
 * repeated allocation or case folding. An all-omitted (or all-empty) criteria object compiles to a predicate that always returns `true`.
 *
 * @param criteria - The filter criteria. See {@link LogFilterCriteria}.
 *
 * @returns A predicate that returns `true` when a record satisfies every active criterion.
 *
 * @category Log Client
 */
export function createLogFilter(criteria: LogFilterCriteria = {}): (record: LogRecord) => boolean {

  const { grep, levels, plugins } = criteria;

  // Normalize the allow-lists once. We lower-case plugin names into a `Set` so per-record plugin matching is a single case-insensitive `Set.has`, and we treat an empty
  // array the same as an omitted field (no constraint) by leaving the corresponding `Set` undefined.
  const levelSet = (levels !== undefined) && (levels.length > 0) ? new Set<LogLevel>(levels) : undefined;
  const pluginSet = (plugins !== undefined) && (plugins.length > 0) ? new Set<string>(plugins.map((plugin) => plugin.toLowerCase())) : undefined;

  return (record: LogRecord): boolean => {

    // Grep: a record fails when an active pattern does not match its message. We test against the ANSI-stripped `message` so a color escape never interferes with the
    // user's pattern. The caller may hand us a `/g`- or `/y`-flagged RegExp whose `.test()` is stateful (it advances `lastIndex` between calls); we reset `lastIndex`
    // to 0 before each test so the predicate is order-independent and a stateful flag cannot cause it to skip a matching record.
    if(grep !== undefined) {

      grep.lastIndex = 0;

      if(!grep.test(record.message)) {

        return false;
      }
    }

    // Level allow-list: a record fails when its level is null (no severity known) or is absent from the allow-list. A null level cannot affirmatively match a requested
    // level, so it is excluded rather than passed.
    if(levelSet !== undefined) {

      if((record.level === null) || !levelSet.has(record.level)) {

        return false;
      }
    }

    // Plugin allow-list: a record fails when its plugin is null or, case-insensitively, absent from the allow-list.
    if(pluginSet !== undefined) {

      if((record.plugin === null) || !pluginSet.has(record.plugin.toLowerCase())) {

        return false;
      }
    }

    // Every active criterion passed (or none were active), so the record is admitted.
    return true;
  };
}
