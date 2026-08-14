/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * formatters.ts: Browser-safe magnitude and percentage formatters shared between the server-side `util.ts` surface and the browser-shipped `featureOptions.ts`
 * model.
 */

/**
 * **Why this file exists.** `featureOptions.ts` ships into `dist/ui/` for the browser to load (via the browser-module copy step). The catalog's built-in
 * formatter registry needs `formatBps`, `formatBytes`, `formatMs`, `formatPercent`, and `formatSeconds` at runtime - and pulling them from `util.ts` would drag in
 * `util.ts`'s `node:timers/promises` import, which the browser cannot resolve. This module is the SSOT for the magnitude-rendering policy. It has zero runtime
 * imports of any kind, so shipping it alongside `featureOptions.js` is safe in any runtime that can execute ES2024+ JavaScript.
 *
 * **Precision policy.** Whole numbers render without a trailing decimal place ("5" not "5.0"); fractional numbers render to one decimal place. Centralizing the
 * precision policy in `formatMagnitude` means tightening it later - more precision, a thousands separator, locale-aware formatting - is a single-line change
 * rather than a sweep across every format helper.
 *
 * **Consumers.** `util.ts` re-exports these for the server-side surface; `featureOptions.ts` imports directly from here to keep its browser-runnable dependency
 * graph free of `util.ts`. Both consumers share one implementation - the file is the join point.
 *
 * @module
 */

// The magnitude ladders that `formatBytes` and `formatMs` test and divide against. Each rung is written as a multiple of the rung below it rather than as a long
// digit run, so the 1024-based and 60-based relationships read straight off the declarations and no value has to be checked digit by digit to be trusted.
// `formatBps` and `formatSeconds` keep their thresholds inline, because their values stay legible as plain digits at the comparison that uses them.
const BYTES_PER_KB = 1024;
const BYTES_PER_MB = 1024 * BYTES_PER_KB;
const BYTES_PER_GB = 1024 * BYTES_PER_MB;
const BYTES_PER_TB = 1024 * BYTES_PER_GB;

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

// Shared magnitude-rendering helper used by every magnitude-based formatter, applying the module's precision policy (see the module doc): whole numbers render with
// no trailing decimal place, fractional numbers to one decimal place.
function formatMagnitude(value: number): string {

  return ((value % 1) === 0 ? value.toFixed(0) : value.toFixed(1));
}

/**
 * Format a bitrate value into a human-readable form as bps, kbps, or Mbps.
 *
 * @param value           - The bitrate value to convert, in bits per second.
 *
 * @returns Returns the value as a human-readable string.
 *
 * @example
 *
 * ```ts
 * formatBps(500);        // "500 bps".
 * formatBps(2000);       // "2 kbps".
 * formatBps(15000);      // "15 kbps".
 * formatBps(2560);       // "2.6 kbps".
 * formatBps(1000000);    // "1 Mbps".
 * formatBps(2560000);    // "2.6 Mbps".
 * ```
 *
 * @category Utilities
 */
export function formatBps(value: number): string {

  if(value < 1000) {

    return value.toString() + " bps";
  }

  if(value < 1000000) {

    return formatMagnitude(value / 1000) + " kbps";
  }

  return formatMagnitude(value / 1000000) + " Mbps";
}

/**
 * Format a byte count into a human-readable form as bytes, KB, MB, GB, or TB. Uses 1024-based thresholds matching the convention every operating system uses for
 * displaying file and buffer sizes.
 *
 * @param value           - The byte count to convert.
 *
 * @returns Returns the value as a human-readable string.
 *
 * @example
 *
 * ```ts
 * formatBytes(512);              // "512 bytes".
 * formatBytes(2048);             // "2 KB".
 * formatBytes(1536);             // "1.5 KB".
 * formatBytes(1048576);          // "1 MB".
 * formatBytes(2621440);          // "2.5 MB".
 * formatBytes(1073741824);       // "1 GB".
 * formatBytes(1099511627776);    // "1 TB".
 * ```
 *
 * @category Utilities
 */
export function formatBytes(value: number): string {

  if(value < BYTES_PER_KB) {

    return value.toString() + " bytes";
  }

  if(value < BYTES_PER_MB) {

    return formatMagnitude(value / BYTES_PER_KB) + " KB";
  }

  if(value < BYTES_PER_GB) {

    return formatMagnitude(value / BYTES_PER_MB) + " MB";
  }

  if(value < BYTES_PER_TB) {

    return formatMagnitude(value / BYTES_PER_GB) + " GB";
  }

  return formatMagnitude(value / BYTES_PER_TB) + " TB";
}

/**
 * Format a millisecond duration into a human-readable form as ms, s, min, or hr. Tiered thresholds match how operators naturally read elapsed time: sub-second
 * values stay in milliseconds for precision, longer durations promote to seconds, minutes, and hours.
 *
 * @param value           - The duration to convert, in milliseconds.
 *
 * @returns Returns the value as a human-readable string.
 *
 * @example
 *
 * ```ts
 * formatMs(250);        // "250 ms".
 * formatMs(1500);       // "1.5 s".
 * formatMs(15000);      // "15 s".
 * formatMs(90000);      // "1.5 min".
 * formatMs(5400000);    // "1.5 hr".
 * ```
 *
 * @category Utilities
 */
export function formatMs(value: number): string {

  if(value < MS_PER_SECOND) {

    return value.toString() + " ms";
  }

  if(value < MS_PER_MINUTE) {

    return formatMagnitude(value / MS_PER_SECOND) + " s";
  }

  if(value < MS_PER_HOUR) {

    return formatMagnitude(value / MS_PER_MINUTE) + " min";
  }

  return formatMagnitude(value / MS_PER_HOUR) + " hr";
}

/**
 * Format a numeric percentage value into a human-readable form with a trailing percent sign. Applies the same precision policy as the magnitude-based formatters
 * via the shared internal helper: whole numbers render without a trailing decimal, fractional numbers render to one decimal place.
 *
 * @param value           - The percentage value to convert. Treated as already-scaled into percent units (50 means 50%, not 0.5).
 *
 * @returns Returns the value as a human-readable string ending in `%`.
 *
 * @example
 *
 * ```ts
 * formatPercent(0);        // "0%".
 * formatPercent(50);       // "50%".
 * formatPercent(100);      // "100%".
 * formatPercent(33.333);   // "33.3%".
 * ```
 *
 * @category Utilities
 */
export function formatPercent(value: number): string {

  return formatMagnitude(value) + "%";
}

/**
 * Format a second-resolution duration into a human-readable form as s, min, or hr. Same tier semantics as {@link formatMs}, scaled for inputs that arrive already
 * in seconds rather than milliseconds.
 *
 * @param value           - The duration to convert, in seconds.
 *
 * @returns Returns the value as a human-readable string.
 *
 * @example
 *
 * ```ts
 * formatSeconds(45);          // "45 s".
 * formatSeconds(90);          // "1.5 min".
 * formatSeconds(1800);        // "30 min".
 * formatSeconds(5400);        // "1.5 hr".
 * ```
 *
 * @category Utilities
 */
export function formatSeconds(value: number): string {

  if(value < 60) {

    return value.toString() + " s";
  }

  if(value < 3600) {

    return formatMagnitude(value / 60) + " min";
  }

  return formatMagnitude(value / 3600) + " hr";
}
