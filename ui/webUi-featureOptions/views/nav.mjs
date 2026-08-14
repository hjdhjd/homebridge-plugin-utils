/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/views/nav.mjs: Sidebar navigation - controllers + devices + scope highlighting + click dispatch.
 */
"use strict";

import { createElement, createSvgElement, errorMessage, toastError } from "../utils.mjs";
import { effect } from "../store.mjs";
import { withDeadline } from "../../webUi-liveness.mjs";

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
 *   - `controllers:loaded` - rebuild the controllers container (the facade's `refreshControllers()` refresh path).
 *   - `devices:loaded` - rebuild the devices container, and repaint both containers' highlighting: this is the transition that records which controller the loaded
 *     device list belongs to, and the controllers highlight reads that.
 *   - `scope:changed` - repaint both containers' highlighting without rebuilding.
 *   - `model:loaded` - initial build (controllers + global link + mode-aware structure).
 *
 * The controller-click handler does I/O: it records the fetch at the store (`devices:requested`, which mints the fetch sequence), calls the caller-supplied
 * `getDevices` callback for the new controller's DeviceListResult, then stamps the outcome onto a `devices:loaded` carrying that sequence. The reducer applies the
 * outcome only when it still answers the pending request, so the sequence is the fetch identity and the newest click owns the store: a superseded controller click's
 * outcome - whether it resolved with devices or rejected - is dropped at the reducer rather than overwriting the newer click's rendered state. A failed fetch's
 * message travels back on that same `devices:loaded` (empty devices, non-empty error), which the reducer turns into the connection-error transition. The handler
 * wraps its fetch in a try/catch so a rejected fetch becomes that same outcome rather than an unhandled rejection; the view layer never silently swallows a failure. The
 * fetch is deadline-bounded, so a click against a bridge that never answers reaches that same catch instead of leaving the sidebar waiting on a device list forever.
 *
 * @param {Object} args
 * @param {number} args.deadlineSeconds - The deadline, in seconds, on the click's device fetch. The orchestrator owns the value; the view owns applying it.
 * @param {((device: import("../../webUi-featureOptions.mjs").Device) => Node | string | null) | undefined} args.deviceContent - Plugin-provided hook composing a
 *        device link's rendered content in place of its name; a null or undefined return falls through to the name. Applies to device links only.
 * @param {(() => Node | string | null) | undefined} args.globalGlyph - Plugin-provided hook supplying the Global Options row's leading kind glyph, invoked once per
 *        sidebar build so each build renders a fresh node. A null or undefined return falls through to the framework's own globe.
 * @param {string} [args.failureGuidance] - The plugin's own guidance for a controller that cannot be reached, carried on this view's outcome dispatches so a click
 *        that fails reads the same way a boot that fails does. Absent leaves the reducer on the framework's shared controller-failure wording.
 * @param {((controller: import("../state.mjs").Controller | null) =>
 *           Promise<import("../../webUi-featureOptions.mjs").DeviceListResult>) | undefined} args.getDevices
 *        - Plugin-provided fetcher resolving a controller's DeviceListResult. Called on controller-link click.
 * @param {string} args.labelControllers - Section header label for the controllers list.
 * @param {string} args.labelDevices - Section header label for the devices list.
 * @param {(() => Promise<void>) | undefined} args.onReenter - The orchestrator's view re-entry, run after a successful refresh so the sidebar rebuilds against the
 *        plugin's freshly-invalidated data. Composed alongside `refresh`; the view itself owns no lifecycle.
 * @param {{ label?: string, onRefresh: Function }} [args.refresh] - The plugin's refresh action, docked on the mode's primary list heading: the controllers heading
 *        where controllers exist, the top-level devices heading where they do not. Absent renders no action, and so does a mode whose primary heading is itself
 *        absent - a fully-grouped device list heads its groups only.
 * @param {HTMLElement} args.rootControllers - The `#controllersContainer` element.
 * @param {HTMLElement} args.rootDevices - The `#devicesContainer` element.
 * @param {AbortSignal} args.signal - Lifecycle signal.
 * @param {import("../store.mjs").FeatureOptionsStore} args.store - The store.
 */
export const mountNavView = ({ deadlineSeconds, deviceContent, failureGuidance = undefined, getDevices, globalGlyph = undefined, labelControllers, labelDevices,
  onReenter = undefined, refresh = undefined, rootControllers, rootDevices, signal, store }) => {

  // Controllers container rebuilds on model:loaded (initial mode/controllers), plus controllers:loaded - the facade's controllers-only refresh path.
  effect({

    events: [ "controllers:loaded", "model:loaded" ],
    fn: () => {

      if(store.state.status.kind === "loading") {

        return;
      }

      buildControllersList({

        controllerLabel: labelControllers,
        globalGlyph,
        mode: store.state.mode,
        onReenter,
        refresh,
        root: rootControllers,
        signal,
        state: store.state
      });
      applyControllersHighlight(rootControllers, store.state.scope, store.state.devicesControllerId);
    },
    signal,
    store
  });

  // Devices container rebuilds on model:loaded (initial structure) and devices:loaded (new controller selected), applying the device highlighting for what it just
  // built. The separate effect below repaints both containers whenever the state the highlights read moves, without rebuilding either.
  effect({

    events: [ "devices:loaded", "model:loaded" ],
    fn: () => {

      if(store.state.status.kind === "loading") {

        return;
      }

      buildDevicesList({

        catalog: store.state.catalog,
        deviceContent,
        deviceLabel: labelDevices,
        devices: store.state.devices,
        mode: store.state.mode,
        onReenter,
        refresh,
        root: rootDevices,
        signal
      });
      applyDevicesHighlight(rootDevices, store.state.scope);
    },
    signal,
    store
  });

  /* Repaint both containers' highlighting without rebuilding their content, on every transition that moves the state the highlights read. That state is two things:
   * the selection pointer, which `scope:changed` moves, and the serial of the controller whose device list is loaded, which `devices:loaded` records.
   *
   * The controllers highlight reads both, which is why `devices:loaded` belongs here and not only on the devices-build effect above. A device fetch that comes back
   * empty moves only the second - the selection stays where it was, and the devices container rebuilds to nothing - so without this subscription nothing would
   * repaint the controller entry that fetch belongs to, and its in-scope outline would never appear.
   */
  effect({

    events: [ "devices:loaded", "scope:changed" ],
    fn: () => {

      applyControllersHighlight(rootControllers, store.state.scope, store.state.devicesControllerId);
      applyDevicesHighlight(rootDevices, store.state.scope);
    },
    signal,
    store
  });

  // Click delegation: one listener on each container resolves the clicked nav link's `data-navigation` and dispatches the appropriate scope-change. The
  // last-request-wins race a controller click can open is owned by the reducer's fetch sequence, so the handler holds no per-mount generation state of its own.
  const onClick = (event) => handleNavClick({ deadlineSeconds, event, failureGuidance, getDevices, signal, store });

  rootControllers.addEventListener("click", onClick, { signal });
  rootDevices.addEventListener("click", onClick, { signal });
};

/* Build a navigation row. Every entry in the sidebar is one of these - Global Options, a controller, a device - so one factory keeps the class set, the identity
 * attributes, and the accessibility shape in a single place, and the click delegation and both highlight passes find every row through the same selector.
 *
 * An entry with no serial emits no `data-device-serial` attribute at all, rather than an empty one: Global Options is a scope rather than a thing with an identity,
 * and the highlight passes read a missing attribute as null, which is exactly what they compare against for it. The content is a list of nodes or strings, which is
 * what lets a row carry a leading glyph beside its label.
 */
const navLink = ({ content, navigation, serial }) => createElement("a", {

  classList: [ "nav-link", "text-decoration-none" ],
  ...((serial === undefined) ? {} : { "data-device-serial": serial }),
  "data-navigation": navigation,
  href: "#",
  role: "button"
}, content);

// The class set every section heading wears. A heading that docks an action adds the flex classes below to it.
const HEADER_CLASSES = [ "nav-header", "text-muted", "text-uppercase", "small", "mb-1" ];

/* Build a section header. The controllers section, the ungrouped-device list, and every device group share the same header markup, so one factory is the single
 * source of that shape. A header that docks an action wraps its label in a span so the two sit as siblings on the heading row; a header without one carries its
 * label as bare text, which is the shape every section that heads nothing but a list keeps.
 *
 * The docked form is a flex row, which is what makes the action's placement a property of the layout rather than of how much room the label happens to leave: the
 * label takes the leading edge, the button is pushed to the trailing edge, and the icon cannot wrap to a line of its own however narrow the sidebar gets. The
 * trailing edge is also the truer reading of the action - it spans the list the heading labels rather than trailing the label like a suffix.
 */
const sectionHeader = ({ action, label }) => createElement("h6", {

  classList: action ? [ ...HEADER_CLASSES, "d-flex", "align-items-center" ] : HEADER_CLASSES
}, action ? [ createElement("span", {}, [label]), action ] : [label]);

/* The refresh glyph: arrowed arcs closing a circle, stroked in the current text color at text scale. Drawing it rather than reaching for a font glyph is what
 * keeps it in step with whatever the row around it is doing - `currentColor` follows the heading's muted color, and `1em` follows the type scale - and `aria-hidden`
 * keeps it out of the accessibility tree, where the button's own label already says what the control does.
 */
const refreshGlyph = () => {

  const svg = createSvgElement({ attributes: {

    "aria-hidden": "true",
    fill: "none",
    height: "1em",
    stroke: "currentColor",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "stroke-width": "2",
    viewBox: "0 0 24 24",
    width: "1em"
  }, tag: "svg" });

  for(const points of [ "23 4 23 10 17 10", "1 20 1 14 7 14" ]) {

    svg.appendChild(createSvgElement({ attributes: { points }, tag: "polyline" }));
  }

  svg.appendChild(createSvgElement({ attributes: { d: "M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" }, tag: "path" }));

  return svg;
};

/**
 * Build the heading's refresh action.
 *
 * The division is the whole design: the plugin's handler invalidates its own domain - clearing a cache, asking a server to re-read - and the framework re-enters the
 * view afterwards, so a plugin never reaches for the page's lifecycle to show its own fresh data. That re-entry is the orchestrator's callback, composed where the
 * connection-error view's retry is composed and running the same re-show.
 *
 * Everything else about the control is the framework's too: the glyph, the ghost treatment borrowed from the page kit, the accessible name taken from the plugin's
 * label, and the in-flight behavior. A click disables the button for both halves, so a slow refresh cannot be asked for twice; a rejected invalidation stops there,
 * because a page that failed to refresh must not present as refreshed, and it reaches the user through the same toast channel every other detached failure uses.
 *
 * @param {Object} args
 * @param {(() => Promise<void>) | undefined} args.onReenter - The orchestrator's re-entry, run after a successful invalidation. Absent only where the view stands
 *        alone, which is the one case that has no rebuild coming.
 * @param {{ label?: string, onRefresh: Function }} args.refresh - The plugin's refresh configuration.
 * @param {AbortSignal} args.signal - Lifecycle signal; the click registration dies with the mount.
 * @returns {HTMLButtonElement} The action button.
 */
const refreshAction = ({ onReenter, refresh, signal }) => {

  const label = refresh.label ?? "Refresh";

  // The treatment is the page kit's `fo-action` ghost and the geometry is `btn-xs`, so nothing here is bespoke; the one layout utility pushes the button to the
  // trailing edge of the heading's flex row, which is where an action that spans the whole list belongs.
  const button = createElement("button", {

    "aria-label": label,
    classList: [ "fo-action", "btn", "btn-xs", "ms-auto" ],
    title: label,
    type: "button"
  }, [refreshGlyph()]);

  button.addEventListener("click", async () => {

    button.disabled = true;

    try {

      await refresh.onRefresh();
    } catch(err) {

      // A failed invalidation stops here: re-entering would present the page as refreshed when nothing was. The control comes back so the user can try again.
      toastError(err);
      button.disabled = false;

      return;
    }

    /* The re-entry tears this sidebar down and builds a fresh one, so the button stays disabled through it: the element dies with the rebuild, and the boot
     * affordance clothes the refetch window in its place. That composition is what makes the whole contract work - the user sees the page reloading rather than a
     * dead control.
     *
     * A view standing alone has no re-entry composed and therefore no rebuild coming, so its control comes back instead of stranding disabled.
     */
    if(onReenter) {

      await onReenter();

      return;
    }

    button.disabled = false;
  }, { signal });

  return button;
};

// Which list heading a refresh action docks on. The controllers heading is the mode's primary list where controllers exist, and the top-level devices heading is the
// primary one where they do not; global-only mounts no navigation at all, so it never asks. One rule in one place, read by both list builders.
const refreshDock = (mode) => (mode === "controller-based") ? "controllers" : "devices";

// Append a labeled section to a container: an optional header followed by one rendered node per item. The header renders only when the section has at least one item,
// so a section that heads nothing emits no header. This is the single enforcement point for the "a header labels a non-empty section" rule - it makes an orphan
// header (a label with no items beneath it) unrepresentable regardless of which list a caller renders, which is what keeps a fully-grouped device set from showing a
// standalone top-level header that labels nothing.
const appendSection = ({ action, items, label, render, root }) => {

  if(!items.length) {

    return;
  }

  if(label) {

    root.appendChild(sectionHeader({ action, label }));
  }

  for(const item of items) {

    root.appendChild(render(item));
  }
};

/* The framework's own mark for the global scope: a stroked globe - outline, equator, one meridian - at text scale in the current color. Drawing it in `currentColor`
 * is what makes it follow the row it sits in without a rule of its own: it picks up the hover tint and the accent foreground of the selected state the same way the
 * label beside it does, in either mode. `aria-hidden` keeps it out of the accessibility tree, where the row's own text already names the scope.
 */
const globeGlyph = () => {

  const svg = createSvgElement({ attributes: {

    "aria-hidden": "true",
    fill: "none",
    height: "1em",
    stroke: "currentColor",
    "stroke-width": "2",
    viewBox: "0 0 24 24",
    width: "1em"
  }, tag: "svg" });

  svg.appendChild(createSvgElement({ attributes: { cx: "12", cy: "12", r: "9" }, tag: "circle" }));
  svg.appendChild(createSvgElement({ attributes: { d: "M3 12h18" }, tag: "path" }));
  svg.appendChild(createSvgElement({ attributes: { cx: "12", cy: "12", rx: "4.5", ry: "9" }, tag: "ellipse" }));

  return svg;
};

/* Build the controllers container: the always-present Global Options row, then - in controller-based mode - the controllers section.
 *
 * Global Options is the one categorically different entry in the list - a scope among things - and it wears that distinction as a quiet leading glyph rather than as
 * a different kind of element. Row anatomy says "clickable" and the glyph says "a different kind of thing", two layers doing one job each, which is why the entry is
 * built through the same factory every other row uses. Its glyph is the plugin's to supply through a hook rather than a stored node, so every rebuild gets a fresh
 * one: a node held in a config slot would be adopted out of it by the first build and be missing from the second.
 */
const buildControllersList = ({ controllerLabel, globalGlyph, mode, onReenter, refresh, root, signal, state }) => {

  root.textContent = "";

  root.appendChild(navLink({ content: [ globalGlyph?.() ?? globeGlyph(), createElement("span", {}, ["Global Options"]) ], navigation: "global" }));

  if(mode !== "controller-based") {

    return;
  }

  // The controllers section. In controller-based mode there is always at least one controller by the time the sidebar builds (the orchestrator shows the
  // no-controllers message and never mounts the nav otherwise), so the non-empty guard is belt-and-suspenders here - but routing through appendSection keeps every
  // section under one rule rather than special-casing this one.
  appendSection({

    action: (refresh && (refreshDock(mode) === "controllers")) ? refreshAction({ onReenter, refresh, signal }) : undefined,
    items: state.controllers,
    label: controllerLabel,
    render: (controller) => navLink({ content: [controller.name], navigation: "controller", serial: controller.serialNumber }),
    root
  });
};

// Build the devices container. The ungrouped devices form the top-level section under the device label; each sidebarGroup forms its own section in alphabetical order.
// Because the device-label header renders only when there is at least one ungrouped device (the appendSection rule), a fully-grouped device set - every device
// carrying a sidebarGroup - shows its group headers alone, with no orphan top-level device header. Controllers are excluded from group derivation (their link lives in
// the controllers container above); the reserved "hidden" group excludes devices from the sidebar entirely.
const buildDevicesList = ({ catalog, deviceContent, deviceLabel, devices, mode, onReenter, refresh, root, signal }) => {

  root.textContent = "";

  if(!devices.length) {

    return;
  }

  const isController = catalog.validators.isController;

  // A device link's content is the plugin's to compose when it supplied the deviceContent hook - a returned Node or string replaces the name, and a null or
  // undefined return falls through to the name so a plugin may adorn some devices and leave the rest alone. The link element itself stays the framework's: its
  // identity attributes, click delegation, and highlighting are what make every row navigate the same way whatever its content looks like.
  const renderDevice = (device) => navLink({ content: [deviceContent?.(device) ?? device.name ?? "Unknown"], navigation: "device", serial: device.serialNumber });

  // Ungrouped devices, headed by the device label. appendSection suppresses the header when there are no ungrouped devices, which is also what decides the refresh
  // action's fate in this mode: a fully-grouped list has no top-level heading to dock on, so the action does not render rather than finding another home.
  appendSection({

    action: (refresh && (refreshDock(mode) === "devices")) ? refreshAction({ onReenter, refresh, signal }) : undefined,
    items: devices.filter((device) => !device.sidebarGroup),
    label: deviceLabel,
    render: renderDevice,
    root
  });

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
// fetch the new controller's DeviceListResult via the caller-supplied `getDevices` callback, carrying the plugin's controller-failure guidance on the outcome so a
// click that cannot reach its controller reads exactly as a boot that cannot.
const handleNavClick = async ({ deadlineSeconds, event, failureGuidance, getDevices, signal, store }) => {

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

      // Optimistic scope update before the fetch so the sidebar highlight repaints immediately. The fetch's outcome lands through the request/outcome pairing
      // below - the reducer owns both the staleness decision and the failure transition - and a devices-bearing outcome selects the controller-as-device entry.
      store.dispatch({ scope: { controllerId: deviceSerial, kind: "controller" }, type: "scope:changed" });

      if(!getDevices) {

        return;
      }

      // Record this fetch at the store's chokepoint before awaiting, then read back the minted sequence - the store's ticket for this fetch. The newest click owns
      // the pending slot, so a superseded click's outcome finds its sequence gone when it lands and drops at the reducer.
      store.dispatch({ controllerId: deviceSerial, type: "devices:requested" });

      const seq = store.state.devicesRequest.seq;

      try {

        const controller = store.state.controllers.find((c) => c.serialNumber === deviceSerial);

        // Bound the fetch. The plugin's hook rides the same bridge every other host call does, so an unanswered click would otherwise leave the sidebar highlighted on
        // a controller whose devices never arrive - the deadline turns that into the rejection the catch below already knows how to render.
        const { devices, error } = await withDeadline({ promise: getDevices(controller ?? null), seconds: deadlineSeconds, signal });

        // Bail if the page tore down; a torn-down store must not be dispatched against. Staleness itself is the reducer's job - it drops an outcome whose sequence no
        // longer answers the pending request.
        if(signal.aborted) {

          return;
        }

        // The guidance rides along unconditionally: the reducer reads it only on the fold a non-empty error triggers and ignores it on a success, so one dispatch
        // shape serves both outcomes.
        store.dispatch({ controllerId: deviceSerial, devices, error, guidance: failureGuidance, seq, type: "devices:loaded" });

        // Gate the follow-up on the reducer's own verdict: select the controller-as-device entry only when my outcome is the one that applied, carried no failure,
        // and returned at least one device. A superseded outcome, a connection failure (the reducer moved the store to connection-error), or an empty controller each
        // leaves the optimistic controller scope standing with no device-scope dispatch.
        if((store.state.devicesAppliedSeq !== seq) || error.length || (devices.length === 0)) {

          return;
        }

        // Select the controller-as-device entry (the first device in the returned list).
        store.dispatch({ scope: { controllerId: deviceSerial, deviceId: devices[0].serialNumber, kind: "device" }, type: "scope:changed" });
      } catch(err) {

        // The page-teardown bail guards the reject path too. Route the rejection (an IPC failure, the contract-guard TypeError) through the same outcome channel: the
        // reducer drops it if a newer click superseded this one, and otherwise clears the stale device list and moves the store to connection-error. A named Error
        // reaches the user verbatim; other junk is stringified.
        if(signal.aborted) {

          return;
        }

        store.dispatch({ controllerId: deviceSerial, devices: [], error: errorMessage(err), guidance: failureGuidance, seq, type: "devices:loaded" });
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
