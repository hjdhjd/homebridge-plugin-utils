/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/views/statusPanel.mjs: The live device-status panel in the sidebar.
 */
"use strict";

import { STATUS_EVENT, STATUS_VIEW_ROUTE } from "../../webui-status.js";
import { buildRecoveryButton } from "../utils.mjs";
import { defaultIdentityFields } from "./deviceInfo.mjs";
import { effect } from "../store.mjs";
import { selectedDevice } from "../selectors.mjs";

/**
 * A status row's static vocabulary. A hand-authored browser-side rendering of `StatusRowTemplate` from `src/webui-status.ts`, the contract owner these typedefs are
 * kept in lockstep with.
 *
 * @typedef {Object} StatusRowTemplate
 * @property {string} id - The stable row identity a `"row"` event addresses to update this row in place.
 * @property {string} label - The human-readable row label.
 * @property {{ seconds: number, value: string }} [latch] - The optional momentary-value latch: a rendered value equal to `latch.value` clears back to the placeholder
 *   after `latch.seconds`.
 * @property {string | string[]} sizer - The widest value the row can produce, as a single string or a non-empty tuple of candidates the panel reserves and maxes.
 */

/**
 * One rendered status row: a {@link StatusRowTemplate} plus its live value. Mirrors `StatusRow` from `src/webui-status.ts`.
 *
 * @typedef {StatusRowTemplate & { value: string }} StatusRow
 */

/**
 * The classified feed-failure reasons. Mirrors `StatusErrorReason` from `src/webui-status.ts`; the component owns default copy for each and merges per-plugin
 * overrides on top.
 *
 * @typedef {"auth-invalid" | "auth-missing" | "not-found" | "timeout" | "unreachable"} StatusErrorReason
 */

/**
 * The bridge push event, tagged on `kind`. Mirrors `StatusEvent` from `src/webui-status.ts`; the handler reads it from the host `MessageEvent`'s `data` property.
 *
 * @typedef {Object} StatusEvent
 * @property {string} kind - The event tag: `"hello"`, `"connecting"`, `"snapshot"`, `"row"`, `"availability"`, or `"error"`.
 * @property {string} [serialNumber] - The device identity, present on every device event and the view request; absent on the server-scoped `"hello"`.
 * @property {number} [session] - The monotonic session token the per-serialNumber guard reads, present on every device event.
 * @property {number} [generation] - The adapter process's opaque generation, on a `"hello"`. Compared by equality alone; a value the panel has not seen marks a fresh
 *   server, so the panel clears its per-device floors and notifies the plugin.
 * @property {boolean} [encrypted] - The transport's encryption state, on snapshot and online-availability events.
 * @property {boolean} [online] - The reachability flag, on availability events.
 * @property {StatusRow[]} [rows] - The authoritative row set, on a snapshot.
 * @property {{ id: string, value: string }} [row] - The single row update, on a `"row"` event.
 * @property {StatusErrorReason} [reason] - The classified failure, on an `"error"` event.
 */

/**
 * The status-panel configuration. A plugin supplies the parts it owns - the identity fields, the placeholder row templates, and any error-copy overrides - and
 * inherits the entire panel around them.
 *
 * @typedef {Object} StatusPanelConfig
 * @property {Partial<Record<StatusErrorReason, { label?: string, message?: string }>>} [errorMessages] - Per-reason overrides merged field-by-field over the
 *   component's credential-neutral default copy: a plugin may replace the label, the message, or both.
 * @property {(device: import("../state.mjs").Device) => { label: string, mono?: boolean, value: string }[]} [identity] - The identity fields for a device. Defaults
 *   to {@link defaultIdentityFields} (firmware / serial number / model / manufacturer). A `mono` field renders its value in the monospace token.
 * @property {{ label?: string, message?: string }} [linkLostMessage] - An override for the browser-detected link-lost copy, merged field-by-field over the
 *   component's default so a plugin may replace the label, the message, or both (a label-only override keeps the default message). The link-lost state is one state, so
 *   the override is a single object rather than a reason-keyed table like {@link StatusPanelConfig.errorMessages}. A plugin that overrides the label owns its width
 *   consequence: the Status sizer reserves the DEFAULT label, the same open-set posture the identity fields carry.
 * @property {number} [linkLostTimeoutSeconds] - The deadline, in seconds, before a watched bridge request that has produced no liveness evidence reads as a lost link.
 *   A missing, zero, negative, or non-finite value falls back to the component's default of 10 seconds.
 * @property {() => void} [onServerHello] - Invoked when a fresh adapter process introduces itself (its hello generation differs from the last seen), after the panel
 *   has cleared its stale-push floors. The plugin re-elicits its feed here - re-sending whatever standing state the new process needs. The contract: keep it cheap (a
 *   boot-time hello may arrive beside the page's own initial elicitation), tolerate overlap (it may fire before any device is viewed, before the model loads, or
 *   concurrently with the plugin's own elicitation paths - route it through the same chokepoint they use), and own the retry posture (the callback fires once per fresh
 *   generation; a plugin whose re-elicitation resets its own suppression state gets natural retries from its next trigger). The signature may gain arguments additively.
 * @property {StatusRowTemplate[]} [placeholderRows] - The row templates the skeleton renders before the first snapshot. Defaults to `[]`, so an unconfigured
 *   skeleton shows the identity and Status cells only and the state rows arrive with the first snapshot.
 */

// The "Connected" Status-cell label, prefixed with the lock glyph for an encrypted session so the panel mirrors a plugin's encrypted-connection convention: the
// U+1F512 lock plus U+FE0E, the text-presentation variation selector that forces a monochrome glyph rather than a color emoji.
const connectedLabel = (encrypted) => encrypted ? "\u{1F512}\u{FE0E} Connected" : "Connected";

// The component's default error copy, one entry per classified reason. Deliberately credential-neutral - auth-invalid / auth-missing describe a rejected or absent
// credential without naming a PSK, password, or token, and not-found says "on the network" rather than naming any one discovery mechanism - so the copy serves every
// adapter, and a plugin overrides any field it wants to specialize.
const DEFAULT_ERROR_COPY = {

  "auth-invalid": { label: "Auth failed", message: "This device rejected the configured credentials." },
  "auth-missing": { label: "Auth required", message: "This device requires credentials that are not configured." },
  "not-found": { label: "Not found", message: "This device was not discovered on the network." },
  "timeout": { label: "No state", message: "This device connected but did not push its state." },
  "unreachable": { label: "Unreachable", message: "This device could not be reached." }
};

// The copy for a reason the table does not recognize, so an unknown reason still renders a definite short label and message rather than empty cells.
const FALLBACK_ERROR_COPY = { label: "Unavailable", message: "This device is unavailable." };

// Resolve the display copy for a classified error. The base is the reason's default entry, or the unrecognized-reason fallback when the table has none; the
// per-plugin override is then merged field-by-field on top, so a label-only override keeps the default message and an unknown reason can never yield empty copy.
const resolveErrorCopy = (reason, overrides) => {

  const base = DEFAULT_ERROR_COPY[reason] ?? FALLBACK_ERROR_COPY;

  return { ...base, ...overrides?.[reason] };
};

// The default copy for the browser-detected link-lost state: the host bridge stopped answering the panel's requests and pushing its events, so the panel renders this
// honest state in place of a silent, permanent "Connecting...". Host-neutral and mechanism-neutral in the error copy's voice - it names the lost connection without
// naming the socket relay or the helper process beneath it, and leaves the one recovery the iframe can offer to the reload action rendered beside it. A plugin merges a
// { label?, message? } override over this field-by-field through the same shape resolveErrorCopy uses; the state is one state, not a reason-keyed vocabulary, so the
// override is a single object.
const DEFAULT_LINK_LOST_COPY = { label: "Link lost", message: "The connection to the Homebridge UI was lost." };

// The link-lost reload action's label, carried by the shared recovery button on its own full-width line beneath the message. The refresh glyph rides the builder, so this
// constant is the bare label without it. It is a plain constant, not part of the override table, because the action is fixed browser behavior a plugin does not re-word.
const LINK_LOST_RELOAD_TEXT = "Refresh Homebridge UI";

// The default deadline, in seconds, before a watched request that has produced no liveness reads as a lost link. It sits well above a healthy bridge's millisecond-scale
// round trip, so a live relay never trips, and low enough that a dead one surfaces promptly. A plugin overrides it through the config's Seconds-suffixed field; a
// missing, zero, negative, or non-finite override falls back here.
const DEFAULT_LINK_LOST_TIMEOUT_SECONDS = 10;

// Resolve a plugin's configured link-lost deadline. A finite positive value stands; anything else - missing, zero, negative, or non-finite (the browser-boundary
// narrowing posture the hello handler shares) - falls back to the module default.
const resolveLinkLostSeconds = (configured) => (Number.isFinite(configured) && (configured > 0)) ? configured : DEFAULT_LINK_LOST_TIMEOUT_SECONDS;

// The resume detector's tick cadence, in seconds. The interval notes the wall-clock time on each tick; a tick that observes far more elapsed time than this cadence is
// the signature of a frozen-then-resumed page. Fifteen seconds keeps the idle cost negligible while sampling often enough that a resume is noticed within one cadence
// of the page waking.
const RESUME_CHECK_INTERVAL_SECONDS = 15;

// The elapsed-wall-clock gap, in seconds, above which a tick reads as a page resume rather than an ordinary tick. The threshold does two jobs at once: it stays a jank
// margin of several check intervals above the cadence, so scheduler jitter never crosses it, and it clears the roughly-once-a-minute cadence a throttled hidden desktop
// tab fires its background ticks at - each throttled tick stores its own timestamp, so its gap stays bounded near that cadence and well under the threshold, while any
// genuine OS suspension runs to minutes and clears it comfortably. The gap is read from the wall clock via Date.now DELIBERATELY: the wall clock is what accrues while JS
// is frozen, whereas a monotonic performance.now is not guaranteed to advance across an OS suspension - a clock that freezes with the page cannot measure the freeze. Two
// honest costs ride the threshold: a suspension shorter than it that still killed the helper goes unseen until the next trigger (the plugin's visibility belt where it
// is delivered, or an interaction), and a forward system-clock step (an NTP correction, a manual change) larger than the threshold fires one false probe - benign,
// identical to a tap on a live bridge - while a backward step masks one real resume until the next tick.
const RESUME_GAP_THRESHOLD_SECONDS = 90;

// The widest candidates for the Status cell's column, living beside the vocabulary they measure. "Disconnected", the encrypted "Connected" label, and the link-lost
// label are within a few pixels of each other depending on the platform font stack, so the column reserves every candidate through the phantom sizer and takes their
// maximum rather than deciding a font-metrics question in code; the Status column then never shifts as its text changes. A plugin that overrides the link-lost label
// owns its width consequence - the sizer reserves the default label, the same open-set posture the identity fields carry.
const STATUS_SIZER = [ "Disconnected", connectedLabel(true), DEFAULT_LINK_LOST_COPY.label ];

// Render a state-row value for display: a blank or empty value shows as a placeholder dash, so an unpopulated cell reads as "no data yet" rather than a rendering gap.
const displayValue = (value) => ((typeof value === "string") && (value.length > 0)) ? value : "-";

/**
 * Build one cell of the panel grid. We construct DOM nodes directly via createElement / textContent rather than concatenating into innerHTML so any HTML
 * metacharacter in a device field renders as text instead of being interpreted as markup - the discovery boundary is the trust line, and treating device-advertised
 * strings as data is the cleanest place to enforce it.
 *
 * When a sizer is supplied, an invisible phantom span carrying each of the column's widest possible values reserves the column's maximum-ever width in the real font
 * (each phantom carries the value's own class plus `.fo-phantom`), so a value can never truncate and the column can never shift; a definite reservation rendered in
 * the actual font needs no dimensional constants. A column with more than one widest candidate passes them all as an array and reserves each, so the browser takes
 * their maximum. The value span keeps its theme ellipsis styling as the guard for the open-set identity fields, which pass no sizer. The row is returned as its
 * container `item` alongside the `valueSpan` itself, so a consumer wiring live updates holds the value cell directly rather than reaching for it by child position;
 * appending the phantom sizers can then never misdirect the value wiring.
 *
 * @param {string} label - The cell's label text.
 * @param {string} value - The cell's initial value text.
 * @param {string} valueClassName - The class applied to the value span (and to each phantom, so phantoms match the value's font).
 * @param {string | string[]} [sizer] - The widest value(s) to reserve, or omitted for an open-set field.
 * @returns {{ item: HTMLElement, valueSpan: HTMLElement }} The cell container and its value span.
 */
const buildStatRow = (label, value, valueClassName, sizer) => {

  const item = document.createElement("div");

  item.className = "stat-item";

  const labelSpan = document.createElement("span");

  labelSpan.className = "stat-label";
  labelSpan.textContent = label;

  const valueSpan = document.createElement("span");

  valueSpan.className = valueClassName;
  valueSpan.textContent = value ?? "";

  item.append(labelSpan, valueSpan);

  // When a sizer is supplied, append an invisible copy of each of the column's widest possible values in the same class - and so the same font - as the value it
  // guards, styled out of paint and out of the accessibility tree by the theme's `.fo-phantom` class. The phantom reserves the column's maximum-ever width so values
  // can never truncate and columns can never shift; a definite reservation rendered in the actual font needs no dimensional constants.
  if(sizer) {

    const candidates = Array.isArray(sizer) ? sizer : [sizer];

    for(const candidate of candidates) {

      const sizerSpan = document.createElement("span");

      sizerSpan.className = valueClassName + " fo-phantom";
      sizerSpan.textContent = candidate;
      sizerSpan.setAttribute("aria-hidden", "true");

      item.append(sizerSpan);
    }
  }

  return { item, valueSpan };
};

/**
 * Mount the live device-status panel into the device-stats region.
 *
 * All render state is closure-local to this mount, so it is fresh for every show() cycle: the viewed device object (its serialNumber always read from that one
 * object), the per-serialNumber highest-token guard, the current row template set, the status text and panel message, the live node references, one latch timer per row
 * id, the pending link-lost watchdog, and the page-resume detector's last-tick clock and interval. The panel subscribes to selection changes and to the host's status
 * push events; every listener is `{ signal }`-scoped, and the one abort listener the mount registers clears every pending latch timer, cancels the pending watchdog, and
 * stops the resume detector on teardown. The returned handle exposes {@link resetStaleGuards} and the plugin-facing watchRequest.
 *
 * @param {Object} args
 * @param {StatusPanelConfig} args.config - The plugin's panel configuration (identity, placeholder rows, error-copy overrides, link-lost copy and deadline).
 * @param {HTMLElement} args.root - The `#deviceStatsContainer` element.
 * @param {AbortSignal} args.signal - Lifecycle signal. Aborting tears down every listener, clears every pending latch timer, cancels the pending watchdog, and stops the
 *   resume detector.
 * @param {import("../store.mjs").FeatureOptionsStore} args.store - The store.
 * @returns {{ resetStaleGuards: () => void, watchRequest: (request: (Promise<unknown> | unknown)) => void }} The panel handle.
 */
export const mountStatusPanelView = ({ config, root, signal, store }) => {

  // Resolve the configured surface once at mount, defaulting each part the plugin did not supply. `identity` and `placeholderRows` fall back to the shared identity
  // quartet and an empty skeleton; `errorMessages` stays possibly-undefined and is consulted only when an error renders; `onServerHello` likewise stays
  // possibly-undefined and is invoked only when a fresh adapter process introduces itself; `linkLostCopy` merges the plugin's override over the default field-by-field
  // (a label-only override keeps the default message); `linkLostTimeoutSeconds` takes the configured deadline only when it is a finite positive number and otherwise
  // falls back to the module default. Reading them once here keeps the handler off `config` on every event.
  const errorMessages = config.errorMessages;
  const identity = config.identity ?? defaultIdentityFields;
  const linkLostCopy = { ...DEFAULT_LINK_LOST_COPY, ...config.linkLostMessage };
  const linkLostTimeoutSeconds = resolveLinkLostSeconds(config.linkLostTimeoutSeconds);
  const onServerHello = config.onServerHello;
  const placeholderRows = config.placeholderRows ?? [];

  // The viewed device and the render state the panel rebuilds from. `viewedDevice` is the single source of the on-screen serialNumber; `highestToken` guards pushes
  // per device; `serverGeneration` is the last adapter generation the panel has adopted (null until the first hello), so an unseen one marks a fresh helper process;
  // `currentRowSet` is the template set the panel renders (the placeholder skeleton until a snapshot replaces it); `statusText` and `panelMessage` are the Status-cell
  // text and the classified message line; `linkLost` is the browser-detected link-lost marker, the one render-state flag the watchdog trip sets and every real render
  // clears. The node references hold the live grid, the Status value span, and one value span per state row.
  let viewedDevice = null;
  const highestToken = new Map();
  let serverGeneration = null;
  let currentRowSet = placeholderRows;
  let statusText = null;
  let panelMessage = null;
  let linkLost = false;
  let panelEl = null;
  let statusValueEl = null;
  const rowValueEls = new Map();

  // One clear-back timer per row id. A row's latch is independent of every other row's, so each holds its own timer here; arming a row clears only that row's own
  // pending timer.
  const latchTimers = new Map();

  // The single pending link-lost watchdog timer, or null when disarmed. One timer serves every in-flight request because the host relay is one socket with one liveness
  // truth: a single answered probe proves the socket for all. Distinct from `linkLost` throughout - this is the timer reference the arm/cancel logic touches, `linkLost`
  // is the render state the trip sets.
  let pendingWatchdog = null;

  // The page-resume detector's state: the wall-clock time of the last tick, seeded at mount, and the running interval handle, or null until armed. The interval reads
  // its own clock each tick and fires the panel's view request when it observes a gap far larger than its cadence - the signature of a page an OS app-switch froze and
  // has just resumed - so a resume trips the link-lost state hands-free even where the browser never delivers a visibilitychange to this iframe.
  let lastResumeTick = Date.now();
  let resumeInterval = null;

  // Clear one row's pending latch timer, if any.
  const clearLatch = (rowId) => {

    const timer = latchTimers.get(rowId);

    if(timer !== undefined) {

      clearTimeout(timer);
      latchTimers.delete(rowId);
    }
  };

  // Clear every pending latch timer. Called on selection change, on global clear, and on signal abort.
  const clearAllLatches = () => {

    for(const timer of latchTimers.values()) {

      clearTimeout(timer);
    }

    latchTimers.clear();
  };

  // Look up a row's static template by id in the current set, so a live push can find the row's latch configuration.
  const templateFor = (rowId) => currentRowSet.find((row) => row.id === rowId);

  // Arm (or re-arm) a row's latch: clear its own pending timer first so an overlapping arrival extends the latch rather than truncating it, then schedule the
  // clear-back. The callback resolves its target AT FIRE TIME by row id against the current value-span map - never a span captured at arm time - so a rebuild between
  // arm and fire clears the live cell rather than a detached one.
  const armLatch = (rowId, seconds) => {

    clearLatch(rowId);

    const timer = setTimeout(() => {

      latchTimers.delete(rowId);

      const valueEl = rowValueEls.get(rowId);

      if(valueEl) {

        valueEl.textContent = displayValue("");
      }
    }, seconds * 1000);

    latchTimers.set(rowId, timer);
  };

  // Drive a row's latch from a freshly rendered value. A row whose template declares a positive latch arms when its value equals the latch value and cancels its
  // pending timer on any other value - without the cancel, a timer armed on the momentary value would later clear a legitimate newer value to the placeholder. A row
  // with no latch, or a non-positive one, does nothing.
  const applyLatch = (rowId, value) => {

    const latch = templateFor(rowId)?.latch;

    if(!latch || !(latch.seconds > 0)) {

      return;
    }

    if(value === latch.value) {

      armLatch(rowId, latch.seconds);
    } else {

      clearLatch(rowId);
    }
  };

  /* Build the panel: ONE bordered grid whose cells wrap into two rows - the identity cells with the live "Status" cell closing the top row, then one cell per state
   * row - inside a single box. The `.fo-status-grid` theme variant owns the wrap, the row gap, and the per-cell flex; the row break is a full-width zero-height
   * spacer at the semantic boundary. A classified message, when present, renders as a full-width wrapping line inside the same box; in the link-lost state that message
   * line takes a prominence modifier and a second full-width line below it carries the reload action. Values come from the caller's harvest map so a rebuild preserves
   * live cell state; statusText, currentRowSet, linkLost, and panelMessage are read from mount state. statusValueEl and rowValueEls are rebuilt here, so a value-cell
   * reference never outlives its own panel.
   */
  const buildPanel = (device, values = new Map()) => {

    const grid = document.createElement("div");

    grid.className = "device-stats-grid fo-status-grid";

    for(const field of identity(device)) {

      const { item, valueSpan } = buildStatRow(field.label, field.value, "stat-value");

      // The one inline style the panel keeps: the identity cell's optional monospace, expressed through the shared font token rather than a host utility class.
      if(field.mono) {

        valueSpan.style.fontFamily = "var(--fo-font-monospace)";
      }

      grid.append(item);
    }

    const { item: statusItem, valueSpan: statusValueSpan } = buildStatRow("Status", statusText ?? "", "stat-value", STATUS_SIZER);

    statusValueEl = statusValueSpan;

    const rowBreak = document.createElement("div");

    rowBreak.className = "fo-row-break";

    grid.append(statusItem, rowBreak);

    rowValueEls.clear();

    for(const row of currentRowSet) {

      const { item, valueSpan } = buildStatRow(row.label, displayValue(values.get(row.id)), "stat-value", row.sizer);

      rowValueEls.set(row.id, valueSpan);
      grid.append(item);
    }

    if(panelMessage) {

      const messageLine = document.createElement("div");

      // In the link-lost state the message line takes a prominence modifier - centered and colored by the theme - so the lost-connection state reads at a glance; an
      // error message renders the base line unchanged. Gating on the marker rather than the message text keeps a copy override from ever colliding with the treatment.
      messageLine.className = linkLost ? "fo-status-message fo-status-linklost" : "fo-status-message";

      const messageSpan = document.createElement("span");

      messageSpan.className = "stat-value";
      messageSpan.textContent = panelMessage;

      messageLine.append(messageSpan);
      grid.append(messageLine);

      // In the link-lost state - and ONLY then, gated on the marker rather than the message text so a copy override can never collide with it - a second full-width line
      // renders below the message: the shared recovery button, whose `{ signal }`-scoped click reloads the top frame and turns the honest state into one-tap recovery.
      // Same-origin holds because the host serves this iframe from its own origin (the CSP's frame-ancestors merely reflects that embedding relationship), so the top
      // frame is reachable; the action is user-initiated only. A type-button element navigates nowhere, so the click has no default to prevent. The error-message path
      // renders no action line.
      if(linkLost) {

        const reloadLine = document.createElement("div");

        reloadLine.className = "fo-status-reload";

        const reloadButton = buildRecoveryButton(LINK_LOST_RELOAD_TEXT);

        reloadButton.addEventListener("click", () => window.top.location.reload(), { signal });

        reloadLine.append(reloadButton);
        grid.append(reloadLine);
      }
    }

    return grid;
  };

  // Update the "Status" cell's single source of truth and, when the panel is mounted, its rendered value.
  const setStatus = (text) => {

    statusText = text;

    if(statusValueEl) {

      statusValueEl.textContent = text;
    }
  };

  // Harvest the current state-row values from the mounted panel's cells, so a rebuild carries live values forward instead of resetting them to placeholders.
  const harvestRowValues = () => {

    const values = new Map();

    for(const [ id, valueEl ] of rowValueEls) {

      values.set(id, valueEl.textContent);
    }

    return values;
  };

  // Rebuild the panel from mount state and swap it in place of the mounted one.
  const refreshPanel = (values) => {

    if(!viewedDevice || !panelEl || !panelEl.parentNode) {

      return;
    }

    const rebuilt = buildPanel(viewedDevice, values);

    panelEl.replaceWith(rebuilt);
    panelEl = rebuilt;
  };

  // Cancel the pending watchdog and null its handle - the one liveness action. Any settled watched request (either way) and any delivered status push call this: the
  // relay answered, so the shared deadline is moot, and the next watched request arms a fresh one. A no-op when nothing is pending.
  const cancelWatchdog = () => {

    if(pendingWatchdog !== null) {

      clearTimeout(pendingWatchdog);
      pendingWatchdog = null;
    }
  };

  // The watchdog fired: the deadline elapsed with no settlement and no push, so the host relay is unresponsive. Null the pending handle FIRST - mirroring the latch fire
  // callback's first-statement self-delete - so detection re-arms for the next watched request rather than staying dead after this one fire. Then set the link-lost
  // marker and render the honest state through the same idiom an error render uses: the link-lost label in the Status cell and the link-lost message with its reload
  // action below it, rebuilt from the live row values. When no panel is mounted, setStatus's null-guarded write and refreshPanel's mount guard leave the trip inert until
  // a device is viewed.
  const tripLinkLost = () => {

    pendingWatchdog = null;
    linkLost = true;

    setStatus(linkLostCopy.label);

    panelMessage = linkLostCopy.message;

    refreshPanel(harvestRowValues());
  };

  // Clear the link-lost marker as a real render's first act. When the marker WAS set, the arriving render proves the relay is live again, so the lingering link-lost
  // message and its reload action are now dishonest: nulling the message and rebuilding drops them even for the kinds ("connecting", "availability", "row") that do not
  // otherwise touch the message line. When the marker was already clear this is a no-op, so every per-kind render can call it unconditionally.
  const clearLinkLost = () => {

    if(!linkLost) {

      return;
    }

    linkLost = false;
    panelMessage = null;

    refreshPanel(harvestRowValues());
  };

  /**
   * Watch one bridge request for the liveness of the host relay - the single chokepoint every watched promise passes, whether the panel's own view request or a request
   * the plugin feeds through the handle. Its first act reads `signal.aborted` DIRECTLY (never a mirrored local flag, which would reopen the window between abort and
   * this check) and returns before attaching anything, so a stale handle's feed after teardown leaves no chain on a dead closure. The input is normalized through
   * `Promise.resolve()` so a non-promise or a thenable feed still tracks as a settled or pending promise - boundary hardening for the plugin-facing half. One watchdog
   * timer serves every in-flight request, because the relay is one socket with one liveness truth: a single answered probe proves the socket for all, so the timer arms
   * only when none is pending and the next watched request re-arms once a settlement cancels it. The settlement hook is two-armed - a resolution AND a rejection both
   * report liveness and are both consumed here, so a rejecting probe counts as a live relay and never surfaces as an unhandled rejection.
   *
   * @param {Promise<unknown> | unknown} request - The request promise to observe, or any value, normalized to a settled promise.
   * @returns {void} Nothing; the watch runs on its own timer and settlement hook, and no caller awaits it.
   */
  const watchRequest = (request) => {

    if(signal.aborted) {

      return;
    }

    const promise = Promise.resolve(request);

    if(pendingWatchdog === null) {

      pendingWatchdog = setTimeout(tripLinkLost, linkLostTimeoutSeconds * 1000);
    }

    // Two-armed settlement hook: a resolution and a rejection both report liveness and are both consumed here, so a rejecting probe never surfaces as an unhandled
    // rejection. A one-armed `.then` or a `.finally` would leave the rejection unconsumed.
    promise.then(cancelWatchdog, cancelWatchdog);
  };

  // Fire the view request as its own liveness probe. The RAW promise feeds the watchdog on one chain, while the console diagnostic rides a SEPARATE chain off the same
  // promise: the watch must observe the raw promise so a rejection reaches its two-armed hook as a rejection - composing the watch after the .catch would convert every
  // rejection into a resolution and blind the rejection-is-liveness path. Results ride push events, not this response.
  const requestView = (serialNumber) => {

    const request = homebridge.request(STATUS_VIEW_ROUTE, { serialNumber });

    watchRequest(request);

    // console is the browser panel's diagnostic transport; a transport failure here is a diagnostic, since feed progress and errors return over push events.
    // eslint-disable-next-line no-console
    request.catch((error) => console.error("The status view request failed.", error));
  };

  /* Render for the currently-selected device. No device (global or controller scope) clears everything - render state, every latch timer, the pending watchdog, the
   * tracked device - and empties the root. The same serialNumber rebuilds in place from harvested live values WITHOUT touching pending latch timers or the watchdog, so
   * a same-device re-render (a devices:loaded / model:loaded re-fire) does not reset a running latch or a deadline mid-flight. A genuinely new serialNumber clears every
   * latch, cancels any pending watchdog so the fresh view never inherits a stale remaining deadline, resets to the placeholder skeleton, mounts the panel, and fires the
   * view request - which re-arms detection on a full fresh deadline; the feed answers over push events.
   */
  const showDetails = (device) => {

    if(!device) {

      clearAllLatches();
      cancelWatchdog();

      viewedDevice = null;
      currentRowSet = placeholderRows;
      statusText = null;
      panelMessage = null;
      linkLost = false;
      panelEl = null;
      statusValueEl = null;

      rowValueEls.clear();
      root.replaceChildren();

      return;
    }

    if(device.serialNumber === viewedDevice?.serialNumber) {

      viewedDevice = device;
      refreshPanel(harvestRowValues());

      return;
    }

    clearAllLatches();
    cancelWatchdog();

    viewedDevice = device;
    currentRowSet = placeholderRows;
    statusText = "Connecting...";
    panelMessage = null;
    linkLost = false;

    panelEl = buildPanel(device);

    root.replaceChildren(panelEl);

    requestView(device.serialNumber);
  };

  // The one floor-clearing chokepoint. Both a fresh-server hello and the plugin-facing resetStaleGuards handle drop the per-serialNumber floors through here, so the
  // clearing semantics live in one place; clearing lets a restarted server's lower tokens be accepted again instead of dropped against stale floors.
  const clearStaleGuards = () => highestToken.clear();

  /* The status push handler. It handles the server-scoped "hello" first, before any per-device work: a hello carries no serialNumber, and an unseen generation marks a
   * fresh helper process, so the panel clears its per-device floors and notifies the plugin to re-elicit its feed - which is how a surviving page recovers from a
   * helper restart it cannot otherwise observe. Every other event is device-scoped, so it applies the per-serialNumber stale-push guard next - dropping any payload
   * whose session token trails the highest seen for that device and recording the token otherwise - then renders only the device on screen; pushes for other pooled
   * devices advance the guard but drive no DOM. It renders by kind: "connecting" sets the Status text; "snapshot" installs the authoritative row set (a row absent from
   * it disappears), sets the connected label with the encrypted lock variant, clears the message, rebuilds, and arms the latch for any installed row whose value equals
   * its latch value; "row" updates one value in place and drives that row's latch; "availability" flips the Status cell; "error" sets the short Status label and the
   * full-sentence message and rebuilds with harvested values. Every real render also clears the link-lost marker as its first act, so a live push retires the honest
   * link-lost state.
   */
  const handleStatusEvent = (event) => {

    // A delivered status push of the panel's own type proves the host relay is live, whatever the payload's shape, so it cancels any pending watchdog as the handler's
    // first act - before the payload guard, so even a payload-less push counts as liveness.
    cancelWatchdog();

    const payload = event.data;

    if(!payload) {

      return;
    }

    // The server-scoped hello is handled before the per-device guard. A hello carries no serialNumber, so the guard's floor comparison could not stop it (an undefined
    // session is never below a floor) and it would otherwise fall through to pollute the token map under an undefined key and then die silently. A generation that is
    // not a finite number is ignored entirely - the browser-boundary narrowing posture - because an undefined generation would collide with the null unseen sentinel
    // and falsely read as a fresh server. A generation the panel has already adopted is a duplicate: no re-clear, no re-notify. An unseen finite generation is a fresh
    // adapter process, so the panel adopts it, clears the per-device floors, and notifies the plugin to re-elicit its feed. No DOM, render state, or latch is touched -
    // the visible recovery arrives with the pushes the plugin's re-elicitation produces.
    if(payload.kind === "hello") {

      const generation = payload.generation;

      if(!Number.isFinite(generation)) {

        return;
      }

      if(generation === serverGeneration) {

        return;
      }

      serverGeneration = generation;

      clearStaleGuards();
      onServerHello?.();

      return;
    }

    const serialNumber = payload.serialNumber;

    if(payload.session < (highestToken.get(serialNumber) ?? 0)) {

      return;
    }

    highestToken.set(serialNumber, payload.session);

    if(serialNumber !== viewedDevice?.serialNumber) {

      return;
    }

    switch(payload.kind) {

      case "connecting":

        clearLinkLost();
        setStatus("Connecting...");

        return;

      case "snapshot": {

        clearLinkLost();
        setStatus(connectedLabel(payload.encrypted));

        currentRowSet = payload.rows.map((row) => ({ id: row.id, label: row.label, latch: row.latch, sizer: row.sizer }));
        panelMessage = null;

        refreshPanel(new Map(payload.rows.map((row) => [ row.id, row.value ])));

        for(const row of payload.rows) {

          applyLatch(row.id, row.value);
        }

        return;
      }

      case "row": {

        clearLinkLost();

        const valueEl = rowValueEls.get(payload.row.id);

        if(valueEl) {

          valueEl.textContent = displayValue(payload.row.value);
        }

        applyLatch(payload.row.id, payload.row.value);

        return;
      }

      case "availability":

        clearLinkLost();
        setStatus(payload.online ? connectedLabel(payload.encrypted) : "Disconnected");

        return;

      case "error": {

        clearLinkLost();

        const copy = resolveErrorCopy(payload.reason, errorMessages);

        setStatus(copy.label);

        panelMessage = copy.message;

        refreshPanel(harvestRowValues());

        return;
      }

      default:

        return;
    }
  };

  // Re-render on selection changes. The loading guard skips the pre-model mount pass (the orchestrator mounts every view before model:loaded, so an immediate-run
  // pass would render against the loading placeholder); the sibling deviceInfo view carries the same guard.
  effect({

    events: [ "scope:changed", "devices:loaded", "model:loaded" ],
    fn: () => {

      if(store.state.status.kind === "loading") {

        return;
      }

      showDetails(selectedDevice(store.state));
    },
    signal,
    store
  });

  // Subscribe to the host's status push events. The host delivers a MessageEvent whose payload rides `event.data`; the listener is `{ signal }`-scoped, so the page
  // signal tears it down.
  homebridge.addEventListener(STATUS_EVENT, handleStatusEvent, { signal });

  /* The page-resume detector's tick. WebKit does not reliably deliver visibilitychange to an embedded iframe's document on an app-switch resume, so the panel cannot
   * trust that event to notice a wake - it reads its own clock instead. Each tick notes the wall-clock time and compares it against the previous tick: a gap far larger
   * than the check cadence is the signature of a page that was frozen while the OS suspended it and has just resumed. The new tick time is stored UNCONDITIONALLY before
   * any probe decision, so a tick that decides not to probe never inflates the next tick's measured gap. The detector consults no visibility state at all: a resumed
   * embedded frame reports its visibility unreliably, since the same WebKit plumbing that drops the change event also leaves the reported state stale, so the gap
   * magnitude alone separates the two cases - a throttled hidden tab's ticks are cadence-bounded and stay under the threshold, while a genuine suspension runs to
   * minutes and clears it. The probe therefore fires whenever a device is viewed (checked FIRST, so the serialNumber read sits behind it and a no-device tick cannot
   * throw) and the gap exceeds the resume threshold. The probe is the panel's own view request - the existing watched chokepoint - fired REGARDLESS of the link-lost
   * marker: on a healed bridge it answers and refreshes the panel after the nap, on a dead one it re-trips the same honest state. A probe landing while a pre-suspension
   * watchdog is already pending rides that overdue deadline; with none pending it arms a fresh full deadline.
   */
  const checkResume = () => {

    const now = Date.now();
    const gap = now - lastResumeTick;

    lastResumeTick = now;

    if(viewedDevice && (gap > (RESUME_GAP_THRESHOLD_SECONDS * 1000))) {

      requestView(viewedDevice.serialNumber);
    }
  };

  // Arm the resume detector, but ONLY when the mount signal is not already aborted. setInterval accepts no { signal } option, and the combined abort hook below is
  // registered `{ once: true }` - so on a pre-aborted mount that hook never fires, and an unguarded arm would leak an interval nothing could ever clear. The guard leaves
  // a pre-aborted mount with no interval at all, matching the effect and push listener that likewise stand down on an aborted signal.
  if(!signal.aborted) {

    resumeInterval = setInterval(checkResume, RESUME_CHECK_INTERVAL_SECONDS * 1000);
  }

  // Clear every pending latch timer, cancel the pending watchdog, and stop the resume detector on teardown - one teardown home for all three. This is the only explicit
  // teardown the mount registers; every other listener is `{ signal }`-scoped. On a same-realm re-show (the menu path reuses the iframe, and show() awaits hide() whose
  // abort fires this hook synchronously before the next mount arms) clearing the interval here is the SOLE reclamation - the iframe's realm dying with the frame is the
  // backstop only for the frame-teardown path. A settlement hook arriving after abort finds no pending watchdog and touches nothing; a watchRequest call on an
  // already-aborted mount returns before arming; and clearInterval on the null handle a pre-aborted mount leaves is a safe no-op.
  signal.addEventListener("abort", () => {

    clearAllLatches();
    cancelWatchdog();
    clearInterval(resumeInterval);
  }, { once: true });

  return {

    // Clear the per-serialNumber stale-push guard. A plugin whose own choreography re-elicits pushes after a server-side restart or re-warm calls this so the fresh
    // server's lower tokens are not dropped against stale floors. Safe at any time: tokens are monotonic within a server lifetime, and the adapter-side
    // session-identity guard is the real stale-push protection.
    resetStaleGuards: clearStaleGuards,

    // Watch a bridge request the plugin fires on its own elicitation paths - a forced re-warm, a resume-path re-elicit. Feeding the raw promise here trips the same
    // link-lost state within one deadline when the request goes unanswered, so a dead bridge surfaces honestly no matter which side fired the probe, while a settlement
    // or any delivered push cancels detection. A call on a torn-down mount reads its already-aborted signal at call time and returns before arming - the same
    // stale-handle safety resetStaleGuards' dead-closure clear provides, harmless by construction.
    watchRequest
  };
};
