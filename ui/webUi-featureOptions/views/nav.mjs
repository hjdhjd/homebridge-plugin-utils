/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/views/nav.mjs: Sidebar navigation - controllers + devices + scope highlighting + click dispatch.
 */
"use strict";

import { createElement } from "../utils.mjs";
import { effect } from "../store.mjs";

/**
 * Mount the sidebar navigation view.
 *
 * The sidebar has two containers (controllers + devices) and three kinds of links:
 *
 *   - **Global Options** (always present, in the controllers container): `data-navigation="global"`. Clicked -> dispatch `scope:changed` with `kind: "global"`.
 *   - **Controller links** (one per controller, in the controllers container, only when mode is controller-based): `data-navigation="controller"` +
 *     `data-device-serial=<serial>`. Clicked -> dispatch `scope:changed` with `kind: "controller"` AND fire `getDevices` for the new controller.
 *   - **Device links** (one per device, in the devices container, when devices for the active controller are loaded): `data-navigation="device"` +
 *     `data-device-serial=<serial>`. Clicked -> dispatch `scope:changed` with `kind: "device"`.
 *
 * Devices group themselves by an optional `sidebarGroup` property: ungrouped devices appear first under the device-label header, then groups appear with their
 * own headers in alphabetical order. The reserved group name "hidden" excludes devices from the sidebar entirely.
 *
 * Subscribes to:
 *
 *   - `controllers:loaded` - rebuild the controllers container.
 *   - `devices:loaded` - rebuild the devices container.
 *   - `scope:changed` - update active-link highlighting without rebuilding.
 *   - `model:loaded` - initial build (controllers + global link + mode-aware structure).
 *
 * The controller-click handler does I/O: it calls the caller-supplied `getDevices` callback to fetch the new controller's devices, then dispatches a
 * `devices:loaded` action. The dispatch is wrapped in a try/catch so a failing fetch surfaces as a `connection:error` action; the view layer never silently
 * swallows a network failure.
 *
 * @param {Object} args
 * @param {((controller: import("../state.mjs").Controller | null) =>
 *           Promise<readonly import("../state.mjs").Device[]>) | undefined} args.getDevices
 *        - Plugin-provided fetcher for a controller's devices. Called on controller-link click.
 * @param {string} args.labelControllers - Section header label for the controllers list.
 * @param {string} args.labelDevices - Section header label for the devices list.
 * @param {{ host: { request: (path: string) => Promise<unknown> } }} args.host - Homebridge bridge (used to fetch the error message on connection failure).
 * @param {HTMLElement} args.rootControllers - The `#controllersContainer` element.
 * @param {HTMLElement} args.rootDevices - The `#devicesContainer` element.
 * @param {AbortSignal} args.signal - Lifecycle signal.
 * @param {import("../store.mjs").FeatureOptionsStore} args.store - The store.
 */
export const mountNavView = ({ getDevices, host, labelControllers, labelDevices, rootControllers, rootDevices, signal, store }) => {

  // Controllers container rebuilds on model:loaded (initial mode/controllers) and controllers:loaded (refresh/retry).
  effect({

    events: [ "controllers:loaded", "model:loaded" ],
    fn: () => {

      if(store.state.status.kind === "loading") {

        return;
      }

      buildControllersList({ controllerLabel: labelControllers, mode: store.state.mode, root: rootControllers, state: store.state });
      applyControllersHighlight(rootControllers, store.state.scope);
    },
    signal,
    store
  });

  // Devices container rebuilds on model:loaded (initial structure) and devices:loaded (new controller selected). Active-link highlighting on scope:changed is the
  // separate effect below.
  effect({

    events: [ "devices:loaded", "model:loaded" ],
    fn: () => {

      if(store.state.status.kind === "loading") {

        return;
      }

      buildDevicesList({ catalog: store.state.catalog, deviceLabel: labelDevices, devices: store.state.devices, root: rootDevices });
      applyDevicesHighlight(rootDevices, store.state.scope);
    },
    signal,
    store
  });

  // scope:changed updates highlighting on both containers without rebuilding their content.
  effect({

    events: ["scope:changed"],
    fn: () => {

      applyControllersHighlight(rootControllers, store.state.scope);
      applyDevicesHighlight(rootDevices, store.state.scope);
    },
    signal,
    store
  });

  // Click delegation: one listener on each container resolves the clicked nav link's `data-navigation` and dispatches the appropriate scope-change.
  const onClick = (event) => handleNavClick({ event, getDevices, host, signal, store });

  rootControllers.addEventListener("click", onClick, { signal });
  rootDevices.addEventListener("click", onClick, { signal });
};

// Build a controller / device navigation link. Both kinds share the same class set and accessibility shape, differing only in their navigation marker and serial, so
// one factory keeps that shape in a single place. The Global Options link is built inline in buildControllersList because it carries a distinct header-style class set.
const navLink = ({ label, navigation, serial }) => createElement("a", {

  classList: [ "nav-link", "text-decoration-none" ],
  "data-device-serial": serial,
  "data-navigation": navigation,
  href: "#",
  role: "button"
}, [label]);

// Build a section header. The controllers section, the ungrouped-device list, and every device group share the same header markup, so one factory is the single
// source of that shape.
const sectionHeader = (label) => createElement("h6", {

  classList: [ "nav-header", "text-muted", "text-uppercase", "small", "mb-1" ]
}, [label]);

// Append a labeled section to a container: an optional header followed by one rendered node per item. The header renders only when the section has at least one item,
// so a section that heads nothing emits no header. This is the single enforcement point for the "a header labels a non-empty section" invariant - it makes an orphan
// header (a label with no items beneath it) unrepresentable regardless of which list a caller renders, which is what keeps a fully-grouped device set from showing a
// standalone top-level header that labels nothing.
const appendSection = ({ items, label, render, root }) => {

  if(!items.length) {

    return;
  }

  if(label) {

    root.appendChild(sectionHeader(label));
  }

  for(const item of items) {

    root.appendChild(render(item));
  }
};

// Build the controllers container: the always-present Global Options link, then - in controller-based mode - the controllers section. The Global Options link carries
// its own header-style class set (bold, uppercase) and is always present, so it is built inline rather than through appendSection.
const buildControllersList = ({ controllerLabel, mode, root, state }) => {

  root.textContent = "";

  root.appendChild(createElement("a", {

    classList: [ "nav-link", "nav-header", "text-decoration-none", "text-uppercase", "fw-bold" ],
    "data-navigation": "global",
    href: "#",
    role: "button"
  }, ["Global Options"]));

  if(mode !== "controller-based") {

    return;
  }

  // The controllers section. In controller-based mode there is always at least one controller by the time the sidebar builds (the orchestrator shows the
  // no-controllers message and never mounts the nav otherwise), so the non-empty guard is belt-and-suspenders here - but routing through appendSection keeps every
  // section under one invariant rather than special-casing this one.
  appendSection({

    items: state.controllers,
    label: controllerLabel,
    render: (controller) => navLink({ label: controller.name, navigation: "controller", serial: controller.serialNumber }),
    root
  });
};

// Build the devices container. The ungrouped devices form the top-level section under the device label; each sidebarGroup forms its own section in alphabetical order.
// Because the device-label header renders only when there is at least one ungrouped device (the appendSection invariant), a fully-grouped device set - every device
// carrying a sidebarGroup - shows its group headers alone, with no orphan top-level device header. Controllers are excluded from group derivation (their link lives in
// the controllers container above); the reserved "hidden" group excludes devices from the sidebar entirely.
const buildDevicesList = ({ catalog, deviceLabel, devices, root }) => {

  root.textContent = "";

  if(!devices.length) {

    return;
  }

  const isController = catalog.validators.isController;
  const renderDevice = (device) => navLink({ label: device.name ?? "Unknown", navigation: "device", serial: device.serialNumber });

  // Ungrouped devices, headed by the device label. appendSection suppresses the header when there are no ungrouped devices.
  appendSection({ items: devices.filter((device) => !device.sidebarGroup), label: deviceLabel, render: renderDevice, root });

  // Grouped devices, each group its own section in alphabetical order. Group derivation excludes controllers and the reserved "hidden" group.
  const groups = [...new Set(devices

    .filter((device) => !isController(device) && device.sidebarGroup && (device.sidebarGroup !== "hidden"))
    .map((device) => device.sidebarGroup))].sort();

  for(const group of groups) {

    appendSection({ items: devices.filter((device) => device.sidebarGroup === group), label: group, render: renderDevice, root });
  }
};

// Highlight the controller link matching the current scope. For global scope the global link activates; for controller / device scope the matching controller's
// link activates (or no link, if the scope's controllerId is not in the current controllers list).
const applyControllersHighlight = (root, scope) => {

  const targetSerial = (scope.kind === "global") ? null : scope.controllerId;

  for(const entry of root.querySelectorAll(".nav-link[data-navigation]")) {

    const isGlobal = entry.getAttribute("data-navigation") === "global";
    const matches = (targetSerial === null) ? isGlobal : (entry.getAttribute("data-device-serial") === targetSerial);

    entry.classList.toggle("active", matches);
  }
};

// Highlight the device link matching the current scope. Device scope activates the matching device link; any other scope kind deactivates every device link.
const applyDevicesHighlight = (root, scope) => {

  const targetSerial = (scope.kind === "device") ? scope.deviceId : null;

  for(const entry of root.querySelectorAll(".nav-link[data-navigation]")) {

    entry.classList.toggle("active", entry.getAttribute("data-device-serial") === targetSerial);
  }
};

// Handle a click on any nav link. Resolves the click target's `data-navigation` and dispatches the corresponding scope-change. Controller clicks additionally
// fetch the new controller's devices via the caller-supplied `getDevices` callback.
const handleNavClick = async ({ event, getDevices, host, signal, store }) => {

  const navLink = event.target.closest(".nav-link[data-navigation]");

  if(!navLink) {

    return;
  }

  event.preventDefault();

  const navigation = navLink.getAttribute("data-navigation");
  const deviceSerial = navLink.getAttribute("data-device-serial");

  switch(navigation) {

    case "global": {

      store.dispatch({ scope: { kind: "global" }, type: "scope:changed" });

      return;
    }

    case "controller": {

      // Optimistic scope update before the fetch so the sidebar highlight repaints immediately. If the fetch fails we transition to connection:error; if it
      // succeeds we dispatch devices:loaded and select the controller-as-device entry (the first device in the returned list).
      store.dispatch({ scope: { controllerId: deviceSerial, kind: "controller" }, type: "scope:changed" });

      if(!getDevices) {

        return;
      }

      try {

        const controller = store.state.controllers.find((c) => c.serialNumber === deviceSerial);
        const devices = await getDevices(controller ?? null);

        if(signal.aborted) {

          return;
        }

        store.dispatch({ devices, type: "devices:loaded" });

        if(devices.length === 0) {

          // No devices returned despite a controller in scope - treat as a connection failure and surface the upstream error message via the host.
          const message = String(await host.request("/getErrorMessage") ?? "");

          if(signal.aborted) {

            return;
          }

          store.dispatch({ message, type: "connection:error" });

          return;
        }

        // Select the controller-as-device entry (the first device in the returned list).
        store.dispatch({ scope: { controllerId: deviceSerial, deviceId: devices[0].serialNumber, kind: "device" }, type: "scope:changed" });
      } catch {

        if(signal.aborted) {

          return;
        }

        store.dispatch({ message: "Failed to fetch devices.", type: "connection:error" });
      }

      return;
    }

    case "device": {

      const controllerId = store.state.scope.kind === "global" ? null : store.state.scope.controllerId;

      store.dispatch({ scope: { controllerId, deviceId: deviceSerial, kind: "device" }, type: "scope:changed" });
    }
  }
};
