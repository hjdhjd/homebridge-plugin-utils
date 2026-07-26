/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/views/deviceInfo.mjs: The device-stats panel in the sidebar.
 */
"use strict";

import { createElement } from "../utils.mjs";
import { effect } from "../store.mjs";
import { selectedDevice } from "../selectors.mjs";

/**
 * Mount the device-info view.
 *
 * Re-renders on every scope change so the stats panel reflects the currently-selected device. The view delegates the actual stats rendering to a caller-supplied
 * `infoPanel` callback - plugins override this to surface plugin-specific device metadata (firmware version, model, status indicators). When no override is
 * supplied, the default callback ({@link defaultInfoPanel}) renders a four-column grid of firmware / serial / model / manufacturer.
 *
 * The container is shown when any device is in scope (controller-as-device or regular device) and cleared when the scope is global (no specific device to show
 * stats for - the global view aggregates options across every device).
 *
 * The renderer receives one options bag, minted fresh on each render. What is per-render and what is per-mount inside that bag differ, and a hook that registers
 * anything depends on the distinction: `device` is per-render data, since the selection moves between renders of a single mount, while `signal` is the mount's own
 * identity - the same AbortSignal object arrives on every render of one mount, and it aborts when the page navigates away or is torn down. A hook that must register
 * a listener or a subscription exactly once, despite being re-invoked per render, therefore keys that once-ness on the signal (or on a flag of its own), and scopes
 * whatever it registers to the signal so the registration dies with the mount.
 *
 * @param {Object} args
 * @param {((args: { device: (import("../state.mjs").Device | undefined), panel: HTMLElement, signal: AbortSignal }) => void) | undefined} args.infoPanel - Optional
 *                                                          plugin-provided renderer. When omitted, {@link defaultInfoPanel} is used.
 * @param {HTMLElement} args.root - The `#deviceStatsContainer` element.
 * @param {AbortSignal} args.signal - Lifecycle signal.
 * @param {import("../store.mjs").FeatureOptionsStore} args.store - The store.
 */
export const mountDeviceInfoView = ({ infoPanel = defaultInfoPanel, root, signal, store }) => {

  const render = (panelFn) => (panelFn ?? defaultInfoPanel)({ device: selectedDevice(store.state), panel: root, signal });

  effect({

    events: [ "scope:changed", "devices:loaded", "model:loaded" ],
    fn: () => {

      // Skip the pre-model mount. The orchestrator mounts every view before model:loaded fires, so this view's immediate-run pass would otherwise render against the
      // loading placeholder - work the model:loaded pass immediately redoes. The sibling views carry the same guard.
      if(store.state.status.kind === "loading") {

        return;
      }

      // The view populates its region but never reveals it; the orchestrator owns region visibility (revealRegions on the success path), so the device-stats panel
      // appears together with the rest of the populated UI rather than the moment this view mounts.
      render(infoPanel);
    },
    signal,
    store
  });
};

/**
 * The default device identity field set: firmware, serial number, model, and manufacturer, each a `{ label, value }` pair with a missing value rendered as `"N/A"`.
 * The single source for the identity quartet, shared by two renderers - {@link defaultInfoPanel} draws it as the device-stats grid, and the live-status panel imports
 * it as its own identity default - so the field set is defined once rather than mirrored.
 *
 * @param {import("../state.mjs").Device} device - The device whose identity fields to read.
 * @returns {{ label: string, value: string }[]} The identity fields in display order.
 */
export const defaultIdentityFields = (device) => [

  { label: "Firmware", value: device.firmwareRevision ?? "N/A" },
  { label: "Serial Number", value: device.serialNumber ?? "N/A" },
  { label: "Model", value: device.model ?? "N/A" },
  { label: "Manufacturer", value: device.manufacturer ?? "N/A" }
];

/**
 * Default device-info renderer. Renders a labeled grid of device identity fields (firmware / serial number / model / manufacturer), each cell carrying a small
 * uppercase label above the value. Clears the container entirely when no device is in scope.
 *
 * Untrusted device fields flow through `textContent` (via createElement's text-node path) so any markup-shaped fragments surface as literal text rather than
 * rendered HTML. Container is rebuilt on every call - replaceChildren handles both the initial render and any subsequent device switch.
 *
 * Takes the same options bag a plugin's own renderer does, so the internal default and the plugin-facing contract are one signature rather than two shapes an
 * adapter has to bridge. It reads only the two keys it needs; the bag's `signal` is for a renderer that registers something, and this one registers nothing.
 *
 * @param {Object} args
 * @param {import("../state.mjs").Device | undefined} args.device - The device to render stats for, or undefined for global view.
 * @param {HTMLElement} args.panel - The container element.
 */
export const defaultInfoPanel = ({ device, panel }) => {

  if(!device) {

    panel.textContent = "";

    return;
  }

  const cells = defaultIdentityFields(device).map(({ label, value }) => createElement("div", { classList: ["stat-item"] }, [

    createElement("span", { classList: ["stat-label"] }, [label]),
    createElement("span", { classList: ["stat-value"] }, [value])
  ]));

  panel.replaceChildren(createElement("div", { classList: ["device-stats-grid"] }, cells));
};
