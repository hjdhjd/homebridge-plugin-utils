/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/views/statusPanel.mjs: The live device-status panel in the sidebar.
 */
"use strict";

import { STATUS_EVENT, STATUS_VIEW_ROUTE } from "../../webui-status.js";
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

// The widest candidates for the Status cell's column, living beside the vocabulary they measure. "Disconnected" and the encrypted "Connected" label are within a few
// pixels of each other depending on the platform font stack, so the column reserves both through the phantom sizer and takes their maximum rather than deciding a
// font-metrics question in code; the Status column then never shifts as its text changes.
const STATUS_SIZER = [ "Disconnected", connectedLabel(true) ];

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
 * object), the per-serialNumber highest-token guard, the current row template set, the status text and panel message, the live node references, and one latch timer
 * per row id. The panel subscribes to selection changes and to the host's status push events; every listener is `{ signal }`-scoped, and the one abort listener the
 * mount registers clears every pending latch timer on teardown. The returned handle exposes {@link resetStaleGuards}.
 *
 * @param {Object} args
 * @param {StatusPanelConfig} args.config - The plugin's panel configuration (identity, placeholder rows, error-copy overrides).
 * @param {HTMLElement} args.root - The `#deviceStatsContainer` element.
 * @param {AbortSignal} args.signal - Lifecycle signal. Aborting tears down every listener and clears every pending latch timer.
 * @param {import("../store.mjs").FeatureOptionsStore} args.store - The store.
 * @returns {{ resetStaleGuards: () => void }} The panel handle.
 */
export const mountStatusPanelView = ({ config, root, signal, store }) => {

  // Resolve the configured surface once at mount, defaulting each part the plugin did not supply. `identity` and `placeholderRows` fall back to the shared identity
  // quartet and an empty skeleton; `errorMessages` stays possibly-undefined and is consulted only when an error renders; `onServerHello` likewise stays
  // possibly-undefined and is invoked only when a fresh adapter process introduces itself. Reading them once here keeps the handler off `config` on every event.
  const errorMessages = config.errorMessages;
  const identity = config.identity ?? defaultIdentityFields;
  const onServerHello = config.onServerHello;
  const placeholderRows = config.placeholderRows ?? [];

  // The viewed device and the render state the panel rebuilds from. `viewedDevice` is the single source of the on-screen serialNumber; `highestToken` guards pushes
  // per device; `serverGeneration` is the last adapter generation the panel has adopted (null until the first hello), so an unseen one marks a fresh helper process;
  // `currentRowSet` is the template set the panel renders (the placeholder skeleton until a snapshot replaces it); `statusText` and `panelMessage` are the Status-cell
  // text and the classified message line. The node references hold the live grid, the Status value span, and one value span per state row.
  let viewedDevice = null;
  const highestToken = new Map();
  let serverGeneration = null;
  let currentRowSet = placeholderRows;
  let statusText = null;
  let panelMessage = null;
  let panelEl = null;
  let statusValueEl = null;
  const rowValueEls = new Map();

  // One clear-back timer per row id. A row's latch is independent of every other row's, so each holds its own timer here; arming a row clears only that row's own
  // pending timer.
  const latchTimers = new Map();

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
   * spacer at the semantic boundary. A classified message, when present, renders as a full-width wrapping line inside the same box. Values come from the caller's
   * harvest map so a rebuild preserves live cell state; statusText, currentRowSet, and panelMessage are read from mount state. statusValueEl and rowValueEls are
   * rebuilt here, so a value-cell reference never outlives its own panel.
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

      messageLine.className = "fo-status-message";

      const messageSpan = document.createElement("span");

      messageSpan.className = "stat-value";
      messageSpan.textContent = panelMessage;

      messageLine.append(messageSpan);
      grid.append(messageLine);
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

  // Fire the view request and swallow any transport rejection: results ride push events, not this response.
  const requestView = (serialNumber) => {

    // console is the browser panel's diagnostic transport; a transport failure here is a diagnostic, since feed progress and errors return over push events.
    // eslint-disable-next-line no-console
    homebridge.request(STATUS_VIEW_ROUTE, { serialNumber }).catch((error) => console.error("The status view request failed.", error));
  };

  /* Render for the currently-selected device. No device (global or controller scope) clears everything - render state, every latch timer, the tracked device - and
   * empties the root. The same serialNumber rebuilds in place from harvested live values WITHOUT touching pending latch timers, so a same-device re-render (a
   * devices:loaded / model:loaded re-fire) does not reset a running latch. A genuinely new serialNumber clears every latch, resets to the placeholder skeleton, mounts
   * the panel, and fires the view request; the feed answers over push events.
   */
  const showDetails = (device) => {

    if(!device) {

      clearAllLatches();

      viewedDevice = null;
      currentRowSet = placeholderRows;
      statusText = null;
      panelMessage = null;
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

    viewedDevice = device;
    currentRowSet = placeholderRows;
    statusText = "Connecting...";
    panelMessage = null;

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
   * full-sentence message and rebuilds with harvested values.
   */
  const handleStatusEvent = (event) => {

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

        setStatus("Connecting...");

        return;

      case "snapshot": {

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

        const valueEl = rowValueEls.get(payload.row.id);

        if(valueEl) {

          valueEl.textContent = displayValue(payload.row.value);
        }

        applyLatch(payload.row.id, payload.row.value);

        return;
      }

      case "availability":

        setStatus(payload.online ? connectedLabel(payload.encrypted) : "Disconnected");

        return;

      case "error": {

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

  // Clear every pending latch timer on teardown. This is the only explicit teardown the mount registers - every other listener is `{ signal }`-scoped.
  signal.addEventListener("abort", clearAllLatches, { once: true });

  return {

    // Clear the per-serialNumber stale-push guard. A plugin whose own choreography re-elicits pushes after a server-side restart or re-warm calls this so the fresh
    // server's lower tokens are not dropped against stale floors. Safe at any time: tokens are monotonic within a server lifetime, and the adapter-side
    // session-identity guard is the real stale-push protection.
    resetStaleGuards: clearStaleGuards
  };
};
