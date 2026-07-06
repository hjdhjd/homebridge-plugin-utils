/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * formatters.ts: Browser-safe magnitude and percentage formatters shared between the server-side `util.ts` surface and the browser-shipped `featureOptions.ts`
 * model.
 */

/**
 * **Why this file exists.** `featureOptions.ts` ships into `dist/ui/` for the browser to load (via the `copyFeatureOptions` build step). The catalog's built-in
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

  if(value < 1_000) {

    return value.toString() + " bps";
  }

  if(value < 1_000_000) {

    return formatMagnitude(value / 1_000) + " kbps";
  }

  return formatMagnitude(value / 1_000_000) + " Mbps";
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
 * formatBytes(512);                  // "512 bytes".
 * formatBytes(2048);                 // "2 KB".
 * formatBytes(1536);                 // "1.5 KB".
 * formatBytes(1_048_576);            // "1 MB".
 * formatBytes(2_621_440);            // "2.5 MB".
 * formatBytes(1_073_741_824);        // "1 GB".
 * formatBytes(1_099_511_627_776);    // "1 TB".
 * ```
 *
 * @category Utilities
 */
export function formatBytes(value: number): string {

  if(value < 1_024) {

    return value.toString() + " bytes";
  }

  if(value < 1_048_576) {

    return formatMagnitude(value / 1_024) + " KB";
  }

  if(value < 1_073_741_824) {

    return formatMagnitude(value / 1_048_576) + " MB";
  }

  if(value < 1_099_511_627_776) {

    return formatMagnitude(value / 1_073_741_824) + " GB";
  }

  return formatMagnitude(value / 1_099_511_627_776) + " TB";
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
 * formatMs(250);          // "250 ms".
 * formatMs(1500);         // "1.5 s".
 * formatMs(15000);        // "15 s".
 * formatMs(90000);        // "1.5 min".
 * formatMs(5_400_000);    // "1.5 hr".
 * ```
 *
 * @category Utilities
 */
export function formatMs(value: number): string {

  if(value < 1_000) {

    return value.toString() + " ms";
  }

  if(value < 60_000) {

    return formatMagnitude(value / 1_000) + " s";
  }

  if(value < 3_600_000) {

    return formatMagnitude(value / 60_000) + " min";
  }

  return formatMagnitude(value / 3_600_000) + " hr";
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

  if(value < 3_600) {

    return formatMagnitude(value / 60) + " min";
  }

  return formatMagnitude(value / 3_600) + " hr";
}
