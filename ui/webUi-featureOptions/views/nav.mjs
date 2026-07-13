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
 * The sidebar has two containers (controllers + devices) and the following kinds of links:
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
 *   - `controllers:loaded` - rebuild the controllers container (a controllers-only refresh hook not currently dispatched).
 *   - `devices:loaded` - rebuild the devices container.
 *   - `scope:changed` - update active-link highlighting without rebuilding.
 *   - `model:loaded` - initial build (controllers + global link + mode-aware structure).
 *
 * The controller-click handler does I/O: it calls the caller-supplied `getDevices` callback to fetch the new controller's DeviceListResult, then dispatches a
 * `devices:loaded` action followed by either a scope change (devices present) or a `connection:error` (the result carried a failure message). A per-mount fetch
 * generation guards the last-resolved-wins race: the newest click owns the store, so a superseded controller click discards its result on both settlement paths
 * (resolve and reject) rather than overwriting the newer click's rendered state. The handler wraps its fetch in a try/catch so a rejected fetch surfaces as a
 * `connection:error` action rather than an unhandled rejection; the view layer never silently swallows a failure.
 *
 * @param {Object} args
 * @param {((controller: import("../state.mjs").Controller | null) =>
 *           Promise<import("../../webUi-featureOptions.mjs").DeviceListResult>) | undefined} args.getDevices
 *        - Plugin-provided fetcher resolving a controller's DeviceListResult. Called on controller-link click.
 * @param {string} args.labelControllers - Section header label for the controllers list.
 * @param {string} args.labelDevices - Section header label for the devices list.
 * @param {HTMLElement} args.rootControllers - The `#controllersContainer` element.
 * @param {HTMLElement} args.rootDevices - The `#devicesContainer` element.
 * @param {AbortSignal} args.signal - Lifecycle signal.
 * @param {import("../store.mjs").FeatureOptionsStore} args.store - The store.
 */
export const mountNavView = ({ getDevices, labelControllers, labelDevices, rootControllers, rootDevices, signal, store }) => {

  // Controllers container rebuilds on model:loaded (initial mode/controllers), plus controllers:loaded - a controllers-only refresh hook not currently dispatched.
  effect({

    events: [ "controllers:loaded", "model:loaded" ],
    fn: () => {

      if(store.state.status.kind === "loading") {

        return;
      }

      buildControllersList({ controllerLabel: labelControllers, mode: store.state.mode, root: rootControllers, state: store.state });
      applyControllersHighlight(rootControllers, store.state.scope, store.state.devicesControllerId);
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

      applyControllersHighlight(rootControllers, store.state.scope, store.state.devicesControllerId);
      applyDevicesHighlight(rootDevices, store.state.scope);
    },
    signal,
    store
  });

  // Per-mount fetch generation for the controller-click handler. Held as a mutable reference (not a plain number) because handleNavClick is module-scope: a number
  // would be copied by value into the call, defeating the guard. The closure-held object mirrors the connection-error view's retryAbort per-mount state. Each
  // controller click captures the incremented generation before its fetch; a continuation whose generation no longer matches has been superseded by a newer click and
  // discards its result.
  const clickFetch = { generation: 0 };

  // Click delegation: one listener on each container resolves the clicked nav link's `data-navigation` and dispatches the appropriate scope-change.
  const onClick = (event) => handleNavClick({ clickFetch, event, getDevices, signal, store });

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
// so a section that heads nothing emits no header. This is the single enforcement point for the "a header labels a non-empty section" rule - it makes an orphan
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
  // section under one rule rather than special-casing this one.
  appendSection({

    items: state.controllers,
    label: controllerLabel,
    render: (controller) => navLink({ label: controller.name, navigation: "controller", serial: controller.serialNumber }),
    root
  });
};

// Build the devices container. The ungrouped devices form the top-level section under the device label; each sidebarGroup forms its own section in alphabetical order.
// Because the device-label header renders only when there is at least one ungrouped device (the appendSection rule), a fully-grouped device set - every device
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

// Highlight the controller link matching the current scope, and mark the in-scope controller. The Global Options link activates only for a true global scope
// (`scope.kind === "global"`), so a device-only device scope - which carries a null controllerId - does not light Global; only the device link
// lights in that case. A controller link activates when its serial matches the scope's controllerId; no controller link activates when that serial is absent (a
// global scope, or a controllerId not in the current list). Separately, the controller whose devices are currently loaded (`devicesControllerId`) carries the
// `context` class so the sidebar can outline it - the affordance that keeps the device list's owning controller identifiable even when the active selection is
// Global (the CSS suppresses it when the entry is `active`).
const applyControllersHighlight = (root, scope, devicesControllerId) => {

  const targetSerial = (scope.kind === "global") ? null : scope.controllerId;

  for(const entry of root.querySelectorAll(".nav-link[data-navigation]")) {

    const isGlobal = entry.getAttribute("data-navigation") === "global";
    const serial = entry.getAttribute("data-device-serial");
    const matches = isGlobal ? (scope.kind === "global") : (serial === targetSerial);

    entry.classList.toggle("active", matches);
    entry.classList.toggle("context", !isGlobal && (devicesControllerId !== null) && (serial === devicesControllerId));
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
// fetch the new controller's DeviceListResult via the caller-supplied `getDevices` callback.
const handleNavClick = async ({ clickFetch, event, getDevices, signal, store }) => {

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

      // Optimistic scope update before the fetch so the sidebar highlight repaints immediately. If the result carries a failure message we transition to
      // connection:error; if it carries devices we select the controller-as-device entry (the first device in the returned list).
      store.dispatch({ scope: { controllerId: deviceSerial, kind: "controller" }, type: "scope:changed" });

      if(!getDevices) {

        return;
      }

      // Capture this fetch's generation before awaiting. The newest click owns the store, so a continuation whose generation no longer matches has been superseded by
      // a later click and discards its result on both settlement paths below.
      const generation = ++clickFetch.generation;

      try {

        const controller = store.state.controllers.find((c) => c.serialNumber === deviceSerial);
        const { devices, error } = await getDevices(controller ?? null);

        // Bail if the page tore down or a newer click superseded this one; a stale continuation must not overwrite the newer click's rendered state.
        if(signal.aborted || (generation !== clickFetch.generation)) {

          return;
        }

        store.dispatch({ controllerId: deviceSerial, devices, type: "devices:loaded" });

        if(error.length) {

          // The result carried a connection-failure message - hand the header to the connection-error view. The message arrived with the device-list response, so no
          // separate request is made.
          store.dispatch({ message: error, type: "connection:error" });

          return;
        }

        if(devices.length === 0) {

          // A legitimately empty controller: the optimistic controller scope stands over the empty list, with no device-scope dispatch.
          return;
        }

        // Select the controller-as-device entry (the first device in the returned list).
        store.dispatch({ scope: { controllerId: deviceSerial, deviceId: devices[0].serialNumber, kind: "device" }, type: "scope:changed" });
      } catch(err) {

        // The same staleness bail guards the reject path: a superseded fetch that rejects (an IPC failure, the contract-guard TypeError) must not dispatch a stale
        // connection:error over the newer click's state. A named Error reaches the user verbatim; non-Error junk falls back to the generic sentence.
        if(signal.aborted || (generation !== clickFetch.generation)) {

          return;
        }

        store.dispatch({ message: (err instanceof Error) ? err.message : "Failed to fetch devices.", type: "connection:error" });
      }

      return;
    }

    case "device": {

      // The device's parent controller is the one whose device list this device belongs to, not the live scope's controller - arriving here from global scope, the
      // scope carries no controller, so reading it would drop the parent and mis-highlight Global. `devicesControllerId` preserves the association.
      const controllerId = store.state.devicesControllerId;

      store.dispatch({ scope: { controllerId, deviceId: deviceSerial, kind: "device" }, type: "scope:changed" });
    }
  }
};
