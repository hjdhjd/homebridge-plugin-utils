/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui/webUi-errors.mjs: How the plugin webUI reads a thrown value as text and surfaces it to the user.
 */

/**
 * The webUI's error reporting, defined once for the page shell and the feature-options subsystem alike: the one rule for turning an arbitrary thrown value into
 * user-facing text, and the host toast that surfaces it.
 *
 * The module holds no store and no plugin knowledge, and imports nothing, which is what lets the page shell and the feature-options subsystem both build on it from
 * below rather than one reaching into the other.
 *
 * @module
 */
"use strict";

/**
 * Extract a user-facing message from an arbitrary thrown value. The webUI's extension points - caller-supplied first-run hooks, plugin device fetchers, the
 * connection-error retry callback, the config re-sync - can reject with any shape (an Error, a string, a plain object, a primitive), so the message is extracted
 * defensively: `err?.message` when the value carries one, a string coercion of the whole value otherwise. This is the single error-to-text truth the webUI shares,
 * so a toast, a nav-view connection-error message, and the sync-failure copy all read the same thrown value the same way. The boot monitor the loader stamps
 * restates this rule inline, because it runs before any module loads, and the loader's suite holds that text equal to this function.
 *
 * @param {*} err - The thrown value to describe.
 * @returns {string} The extracted message.
 */
export function errorMessage(err) {

  return err?.message ?? String(err);
}

/**
 * Surface an arbitrary thrown value as an error toast. Routes the value through {@link errorMessage} so the toast text stays useful regardless of what bubbled out.
 *
 * @param {*} err - The thrown value to surface.
 * @param {*} [host=homebridge] - The bridge whose error toast shows the value. The shell's callers read the global bridge at call time, while a subsystem that
 *   already injects its host passes that host through, so one route and one title serve every error toast in the webUI.
 */
export function toastError(err, host = homebridge) {

  host.toast.error(errorMessage(err), "Error");
}
