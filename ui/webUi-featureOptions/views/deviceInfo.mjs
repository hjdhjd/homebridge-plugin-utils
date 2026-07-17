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
 * @param {Object} args
 * @param {((root: HTMLElement, device: import("../state.mjs").Device | undefined) => void) | undefined} args.infoPanel - Optional plugin-provided renderer. When
 *                                                                                                                          omitted, {@link defaultInfoPanel} is used.
 * @param {HTMLElement} args.root - The `#deviceStatsContainer` element.
 * @param {AbortSignal} args.signal - Lifecycle signal.
 * @param {import("../store.mjs").FeatureOptionsStore} args.store - The store.
 */
export const mountDeviceInfoView = ({ infoPanel = defaultInfoPanel, root, signal, store }) => {

  const render = (panelFn) => (panelFn ?? defaultInfoPanel)(root, selectedDevice(store.state));

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
 * Default device-info renderer. Renders a labeled grid of device identity fields (firmware / serial number / model / manufacturer), each cell carrying a small
 * uppercase label above the value. Clears the container entirely when no device is in scope.
 *
 * Untrusted device fields flow through `textContent` (via createElement's text-node path) so any markup-shaped fragments surface as literal text rather than
 * rendered HTML. Container is rebuilt on every call - replaceChildren handles both the initial render and any subsequent device switch.
 *
 * @param {HTMLElement} root - The container element.
 * @param {import("../state.mjs").Device | undefined} device - The device to render stats for, or undefined for global view.
 */
export const defaultInfoPanel = (root, device) => {

  if(!device) {

    root.textContent = "";

    return;
  }

  const stats = [

    [ "Firmware", device.firmwareRevision ?? "N/A" ],
    [ "Serial Number", device.serialNumber ?? "N/A" ],
    [ "Model", device.model ?? "N/A" ],
    [ "Manufacturer", device.manufacturer ?? "N/A" ]
  ];

  const grid = createElement("div", { classList: ["device-stats-grid"] }, stats.map(([ label, value ]) => createElement("div", { classList: ["stat-item"] }, [

    createElement("span", { classList: ["stat-label"] }, [label]),
    createElement("span", { classList: ["stat-value"] }, [value])
  ])));

  root.replaceChildren(grid);
};
