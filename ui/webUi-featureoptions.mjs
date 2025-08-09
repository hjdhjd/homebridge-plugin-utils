/* Copyright(C) 2017-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureoptions.mjs: Device feature option webUI.
 */
"use strict";

import { FeatureOptions} from "./featureoptions.js";

/**
 * @typedef {Object} Device
 * @property {string} firmwareRevision - The firmware version of the device.
 * @property {string} manufacturer - The manufacturer of the device.
 * @property {string} model - The model identifier of the device.
 * @property {string} name - The display name of the device.
 * @property {string} serialNumber - The unique serial number of the device.
 * @property {string} [sidebarGroup] - Optional grouping identifier for sidebar organization.
 */

/**
 * @typedef {Object} Controller
 * @property {string} address - The network address of the controller.
 * @property {string} serialNumber - The unique serial number of the controller.
 * @property {string} name - The display name of the controller.
 */

/**
 * @typedef {Object} Category
 * @property {string} name - The internal name of the category.
 * @property {string} description - The user-friendly description of the category.
 */

/**
 * @typedef {Object} Option
 * @property {string} name - The option name.
 * @property {string} description - The user-friendly description.
 * @property {boolean} default - The default state of the option.
 * @property {*} [defaultValue] - The default value for value-centric options.
 * @property {number} [inputSize] - The character width for input fields.
 * @property {string} [group] - The parent option this option depends on.
 */

/**
 * @typedef {Object} FeatureOptionsConfig
 * @property {Function} [getControllers] - Handler to retrieve available controllers.
 * @property {Function} [getDevices] - Handler to retrieve devices for a controller.
 * @property {Function} [infoPanel] - Handler to display device information.
 * @property {Object} [sidebar] - Sidebar configuration options.
 * @property {string} [sidebar.controllerLabel="Controllers"] - Label for the controllers section.
 * @property {string} [sidebar.deviceLabel="Devices"] - Label for the devices section.
 * @property {Function} [sidebar.showDevices] - Handler to display devices in the sidebar.
 * @property {Object} [ui] - UI validation and display options.
 * @property {number} [ui.controllerRetryEnableDelayMs=5000] - Interval before enabling a retry button when connecting to a controller.
 * @property {Function} [ui.isController] - Validates if a device is a controller.
 * @property {Function} [ui.validOption] - Validates if an option should display for a device.
 * @property {Function} [ui.validOptionCategory] - Validates if a category should display for a device.
 */

/**
 * webUiFeatureOptions - Manages the feature options user interface for Homebridge plugins.
 *
 * This class provides a comprehensive UI for managing hierarchical feature options with support for global, controller-specific, and device-specific settings.
 * It implements a three-state checkbox system (checked/unchecked/indeterminate) to show option inheritance and provides search, filtering, and bulk management
 * capabilities.
 *
 * @example
 * // Basic usage with default configuration. This creates a feature options UI that reads devices from Homebridge's accessory cache and displays them in a
 * // simple device-only mode without controller hierarchy.
 * const featureOptionsUI = new webUiFeatureOptions();
 * await featureOptionsUI.show();
 *
 * @example
 * // Advanced usage with controller hierarchy and custom device retrieval. This example shows how to configure the UI for a plugin that connects to network
 * // controllers which manage multiple devices. The UI will display a three-level hierarchy: global options, controller-specific options, and device-specific
 * // options.
 * const featureOptionsUI = new webUiFeatureOptions({
 *   // Custom controller retrieval function. This should return an array of controller objects with address, serialNumber, and name properties.
 *   getControllers: async () => {
 *     const controllers = await myPlugin.discoverControllers();
 *     return controllers.map(c => ({
 *       address: c.ip,
 *       serialNumber: c.mac,
 *       name: c.hostname
 *     }));
 *   },
 *
 *   // Custom device retrieval function. When a controller is provided, this should return devices from that controller. When null is provided, it might
 *   // return cached devices or an empty array depending on your plugin's architecture.
 *   getDevices: async (controller) => {
 *     if(!controller) {
 *       return [];
 *     }
 *
 *     // Connect to the controller and retrieve its devices. The first device in the array must always be a representation of the controller itself,
 *     // which allows controller-specific options to be configured.
 *     const devices = await myPlugin.getDevicesFromController(controller.address);
 *     return devices;
 *   },
 *
 *   // Custom information panel. This displays device-specific information in the UI's info panel when a device is selected.
 *   infoPanel: (device) => {
 *     if(!device) {
 *       return;
 *     }
 *
 *     // Update the info panel with device-specific information. You can show any relevant details here like firmware version, model, status, etc.
 *     document.getElementById("device_firmware").textContent = device.firmwareRevision || "Unknown";
 *     document.getElementById("device_model").textContent = device.model || "Unknown";
 *     document.getElementById("device_status").textContent = device.isOnline ? "Online" : "Offline";
 *   },
 *
 *   // Customize the sidebar labels. These labels appear as section headers in the navigation sidebar.
 *   sidebar: {
 *     controllerLabel: "UniFi Controllers",
 *     deviceLabel: "Protect Devices"
 *   },
 *
 *   // UI validation functions. These control which options and categories are displayed for different device types.
 *   ui: {
 *     // Determine if a device is actually a controller. Controllers get different options than regular devices.
 *     isController: (device) => {
 *       return device?.type === "controller" || device?.isController === true;
 *     },
 *
 *     // Validate if an option should be shown for a specific device. This allows hiding irrelevant options based on device capabilities.
 *     validOption: (device, option) => {
 *       // Don't show camera-specific options for non-camera devices. This keeps the options relevant to each device type.
 *       if(option.name.startsWith("Video.") && device?.type !== "camera") {
 *         return false;
 *       }
 *
 *       // Don't show doorbell options for non-doorbell cameras. This provides fine-grained control over option visibility.
 *       if(option.name.startsWith("Doorbell.") && !device?.hasChime) {
 *         return false;
 *       }
 *
 *       return true;
 *     },
 *
 *     // Validate if a category should be shown for a specific device. This allows hiding entire categories that don't apply.
 *     validOptionCategory: (device, category) => {
 *       // Hide the "Motion Detection" category for devices without motion sensors. This keeps the UI focused and relevant.
 *       if(category.name === "Motion" && !device?.hasMotionSensor) {
 *         return false;
 *       }
 *
 *       return true;
 *     }
 *   }
 * });
 *
 * // Display the UI. The show method is async because it needs to load configuration data and potentially connect to controllers.
 * await featureOptionsUI.show();
 *
 * // Clean up when done. This removes all event listeners and frees resources to prevent memory leaks.
 * featureOptionsUI.cleanup();
 */
export class webUiFeatureOptions {

  // Table containing the currently displayed feature options.
  #configTable;

  // The current controller context representing the controller serial number when viewing controller or device options.
  #controller;

  // Controllers sidebar container element that holds the global options link and controller navigation links.
  #controllersContainer;

  // The current plugin configuration array retrieved from Homebridge.
  currentConfig;

  // Container element for device statistics display in the info panel.
  #deviceStatsContainer;

  // Current list of devices retrieved from either the Homebridge accessory cache or a network controller.
  #devices;

  // Container element for the list of devices in the sidebar navigation.
  #devicesContainer;

  // Map of registered event listeners for cleanup management. Keys are unique identifiers, values contain element references and handler details.
  #eventListeners;

  // Feature options instance that manages the option hierarchy and state logic.
  #featureOptions;

  // Handler function for retrieving available controllers. Optional - when not provided, the UI operates in device-only mode.
  #getControllers;

  // Handler function for retrieving devices. Defaults to reading from Homebridge's accessory cache if not provided.
  #getDevices;

  // Device information panel handler function for displaying device-specific details.
  #infoPanel;

  // The original set of feature options captured when the UI is first displayed. Used for reverting changes to the last saved state.
  #initialFeatureOptions;

  // Search panel container element that holds the search input, filters, and status bar.
  #searchPanel;

  // Sidebar configuration parameters with sensible defaults. Stores labels for controller and device sections.
  #sidebar = {

    controllerLabel: "Controllers"
  };

  // Theme color scheme that's currently in use in the Homebridge UI.
  #themeColor = {

    background: "",
    text: ""
  };

  // Options UI configuration parameters with sensible defaults. Contains validation functions for controllers, options, and categories.
  #ui = {

    controllerRetryEnableDelayMs: 5000,
    isController: () => false,
    validOption: () => true,
    validOptionCategory: () => true
  };

  /**
   * Initialize the feature options webUI with customizable configuration.
   *
   * The webUI supports two modes: controller-based (devices grouped under controllers) and direct device mode (devices without controller hierarchy). All
   * configuration options are optional and will use sensible defaults if not provided.
   *
   * @param {FeatureOptionsConfig} options - Configuration options for the webUI.
   */
  constructor(options = {}) {

    // Extract options with defaults. We destructure here to get clean references to each configuration option while providing fallbacks.
    const {

      getControllers = undefined,
      getDevices = this.getHomebridgeDevices,
      infoPanel = this.#showDeviceInfoPanel,
      sidebar = {},
      ui = {}
    } = options;

    // Initialize all our properties. We cache DOM elements for performance and maintain state for the current controller and device context.
    this.#configTable = document.getElementById("configTable");
    this.#controller = null;
    this.#controllersContainer = document.getElementById("controllersContainer");
    this.currentConfig = [];
    this.#deviceStatsContainer = document.getElementById("deviceStatsContainer");
    this.#devices = [];
    this.#devicesContainer = document.getElementById("devicesContainer");
    this.#eventListeners = new Map();
    this.#featureOptions = null;
    this.#getControllers = getControllers;
    this.#getDevices = getDevices;
    this.#infoPanel = infoPanel;
    this.#searchPanel = document.getElementById("search");

    // Merge the provided options with our defaults. This allows partial configuration while maintaining our sensible defaults.
    Object.assign(this.#sidebar, sidebar);
    Object.assign(this.#ui, ui);
  }

  /**
   * Register an event listener for later cleanup.
   *
   * This helper ensures we can properly clean up all event listeners when the UI is refreshed or destroyed. This prevents memory leaks that would otherwise
   * occur from accumulating event listeners over time.
   *
   * @param {EventTarget} element - The DOM element to attach the listener to.
   * @param {string} event - The event type to listen for.
   * @param {EventListener} handler - The event handler function.
   * @param {AddEventListenerOptions} [options] - Optional event listener options.
   * @returns {string} A unique key that can be used to remove this specific listener.
   * @private
   */
  #addEventListener(element, event, handler, options) {

    // Add the event listener to the element.
    element.addEventListener(event, handler, options);

    // Store the listener information for cleanup. We generate a unique key using timestamp and random number to ensure uniqueness.
    const key = "element-" + Date.now() + "-" + Math.random();

    this.#eventListeners.set(key, { element, event, handler, options });

    return key;
  }

  /**
   * Remove a specific event listener by its key.
   *
   * This allows targeted removal of individual event listeners when needed, such as when removing temporary confirmation handlers.
   *
   * @param {string} key - The unique key returned by #addEventListener.
   * @private
   */
  #removeEventListener(key) {

    const listener = this.#eventListeners.get(key);

    if(listener) {

      listener.element.removeEventListener(listener.event, listener.handler, listener.options);
      this.#eventListeners.delete(key);
    }
  }

  /**
   * Clean up all registered event listeners.
   *
   * This prevents memory leaks when switching views or updating the UI. We iterate through all stored listeners and remove them from their elements before
   * clearing our tracking map.
   *
   * @private
   */
  #cleanupEventListeners() {

    // Remove all stored event listeners. We use for...of to iterate through the values since we don't need the keys here.
    for(const listener of this.#eventListeners.values()) {

      listener.element.removeEventListener(listener.event, listener.handler, listener.options);
    }

    // Clear the map to release all references.
    this.#eventListeners.clear();
  }

  /**
   * Initialize event delegation handlers for the entire feature options interface.
   *
   * This sets up all our event delegation handlers on parent containers. By using event delegation, we can handle events for dynamically created elements
   * without attaching individual listeners. This improves performance and memory usage while simplifying our event management.
   *
   * @private
   */
  #initializeEventDelegation() {

    // Get the main feature options container for event delegation.
    const featureOptionsPage = document.getElementById("pageFeatureOptions");

    if(!featureOptionsPage) {

      // If we can't find the container, we're likely not in the right context yet.
      return;
    }

    // Handle all sidebar navigation clicks through delegation. This covers global options, controller links, and device links.
    this.#addEventListener(featureOptionsPage, "click", async (event) => {

      // Check for sidebar navigation links.
      const navLink = event.target.closest(".nav-link[data-navigation]");

      if(navLink) {

        event.preventDefault();

        const navigationType = navLink.getAttribute("data-navigation");

        // Handle different navigation types.
        switch(navigationType) {

          case "global":

            this.#showGlobalOptions();

            break;

          case "controller":

            await this.#showControllerOptions(navLink.getAttribute("data-device-serial"));

            break;

          case "device":

            this.#showDeviceOptions(navLink.name);

            break;

          default:

            break;
        }

        return;
      }

      // Check for filter buttons.
      const filterButton = event.target.closest(".btn[data-filter]");

      if(filterButton) {

        // Determine the class based on the filter type. We start with our default of btn-primary.
        let filterClass = "btn-primary";

        if(filterButton.getAttribute("data-filter") === "modified") {

          filterClass = "btn-warning text-dark";
        }

        // Create our parameters to pass along to the click handler.
        const filterConfig = {

          class: filterClass,
          filter: filterButton.getAttribute("data-filter-type") ?? filterButton.getAttribute("data-filter"),
          text: filterButton.textContent
        };

        this.#handleFilterClick(filterButton, filterConfig);

        return;
      }

      // Handle expanding and collapsing all feature option categories when toggled.
      const toggleButton = event.target.closest("#toggleAllCategories");

      if(toggleButton) {

        this.#handleToggleClick(toggleButton);

        return;
      }

      // Handle any button with a reset-related action.
      const resetButton = event.target.closest(".btn[data-action^='reset']");

      if(resetButton) {

        const action = resetButton.getAttribute("data-action");
        const resetDefaultsBtn = resetButton.parentElement.querySelector("button[data-action='reset-defaults']");
        const resetRevertBtn = resetButton.parentElement.querySelector("button[data-action='reset-revert']");

        switch(action) {

          case "reset-toggle":

            resetDefaultsBtn?.classList.toggle("d-none");
            resetRevertBtn?.classList.toggle("d-none");
            resetButton.textContent = resetDefaultsBtn?.classList.contains("d-none") ? "Reset..." : "\u25B6";

            break;

          case "reset-defaults":
          case "reset-revert":

            if(action === "reset-defaults") {

              await this.#resetAllOptions();
            } else {

              await this.#revertToInitialOptions();
            }

            resetButton.classList.toggle("d-none");
            resetRevertBtn?.classList.toggle("d-none");

            break;

          default:

            break;
        }

        return;
      }

      // Handle expanding or collapsing a feature option category when its header is clicked.
      const headerCell = event.target.closest("table[data-category] thead th");

      if(headerCell) {

        const table = headerCell.closest("table");
        const tbody = table.querySelector("tbody");

        if(tbody) {

          const isCollapsed = tbody.style.display === "none";

          tbody.style.display = isCollapsed ? "" : "none";

          const arrow = table.querySelector(".arrow");

          if(arrow) {

            arrow.textContent = isCollapsed ? "\u25BC " : "\u25B6 ";
          }

          // Update accessibility state to reflect the current expansion state for assistive technologies.
          headerCell.setAttribute("aria-expanded", isCollapsed ? "true" : "false");

          document.getElementById("toggleAllCategories")?.updateState?.();
        }

        return;
      }

      // Check for option labels (but not if clicking on inputs). Clicking a label toggles the associated checkbox for better UX.
      const labelCell = event.target.closest("td.option-label");

      if(labelCell && !event.target.closest("input")) {

        labelCell.closest("tr").querySelector("input[type='checkbox']")?.click();
      }
    });

    // Handle checkbox changes through delegation.
    this.#addEventListener(featureOptionsPage, "change", (event) => {

      // Check for option checkboxes.
      if(event.target.matches("input[type='checkbox']")) {

        const checkbox = event.target;
        const optionName = checkbox.id;
        const deviceSerial = checkbox.getAttribute("data-device-serial");

        // Find the option in the feature options.
        const categoryName = event.target.closest("table[data-category]")?.getAttribute("data-category");

        if(!categoryName) {

          return;
        }

        const option = this.#featureOptions.options[categoryName]?.find(opt => this.#featureOptions.expandOption(categoryName, opt) === optionName);

        if(!option) {

          return;
        }

        if(option) {

          const device = deviceSerial ? this.#devices.find(device => device.serialNumber === deviceSerial) : null;
          const label = checkbox.closest("tr").querySelector(".option-label label");
          const inputValue = checkbox.closest("tr").querySelector("input[type='text']");

          this.#handleOptionChange(checkbox, optionName, option, device, label, inputValue);
        }

        return;
      }

      // Check for value inputs. When a text input changes, we trigger the checkbox change event to update the configuration.
      if(event.target.matches("input[type='text']")) {

        event.target.closest("tr").querySelector("input[type='checkbox']")?.dispatchEvent(new Event("change", { bubbles: true }));

        return;
      }
    });

    // Handle search input through delegation with debouncing for performance.
    this.#addEventListener(featureOptionsPage, "input", (event) => {

      if(event.target.matches("#searchInput")) {

        const searchInput = event.target;

        if(!searchInput._searchTimeout) {

          searchInput._searchTimeout = null;
        }

        clearTimeout(searchInput._searchTimeout);

        searchInput._searchTimeout = setTimeout(() => {

          this.#handleSearch(searchInput.value.trim(),
            [...document.querySelectorAll("#configTable tbody tr")],
            [...document.querySelectorAll("#configTable table")],
            searchInput._originalVisibility || new Map()
          );
        }, 300);
      }
    });

    // Handle keyboard events for search shortcuts and navigation.
    this.#addEventListener(featureOptionsPage, "keydown", (event) => {

      // Handle escape key in search input to clear the search.
      if(event.target.matches("#searchInput") && (event.key === "Escape")) {

        event.target.value = "";
        event.target.dispatchEvent(new Event("input", { bubbles: true }));
      }

      // Ctrl/Cmd+F to focus search when the search panel is visible.
      if((event.ctrlKey || event.metaKey) && (event.key === "f")) {

        const searchInput = document.getElementById("searchInput");

        if(searchInput && this.#searchPanel && (this.#searchPanel.style.display !== "none")) {

          event.preventDefault();
          searchInput.focus();
          searchInput.select();
        }
      }

      // Allow expanding/collapsing categories via keyboard. We support Enter and Space as expected.
      if(event.target.matches("table[data-category] thead th") && ((event.key === "Enter") || (event.key === " "))) {

        event.preventDefault();

        const headerCell = event.target.closest("table[data-category] thead th");

        if(headerCell) {

          headerCell.click();
        }
      }
    });
  }

  /**
   * Create a DOM element with optional properties and children.
   *
   * This helper reduces the verbosity of DOM manipulation throughout the code. It handles common patterns like setting classes, styles, and adding children
   * in a more functional style.
   *
   * @param {string} tag - The HTML tag name to create.
   * @param {Object} [props={}] - Properties to set on the element.
   * @param {string|string[]|Array} [props.classList] - CSS classes to add.
   * @param {Object} [props.style] - Inline styles to apply.
   * @param {Array<string|Node>} [children=[]] - Child nodes or text content.
   * @returns {HTMLElement} The created DOM element.
   * @private
   */
  #createElement(tag, props = {}, children = []) {

    const element = document.createElement(tag);

    // Apply any CSS classes. We handle both single classes and arrays, making the API flexible for callers.
    if(props.classList) {

      const classes = Array.isArray(props.classList) ? props.classList : props.classList.split(" ");

      element.classList.add(...classes);
      delete props.classList;
    }

    // Apply any inline styles. We use Object.assign for efficiency when setting multiple style properties at once.
    if(props.style) {

      Object.assign(element.style, props.style);
      delete props.style;
    }

    // Apply all other properties. This handles standard DOM properties like id, name, type, etc.
    for(const [ key, value ] of Object.entries(props)) {

      // Data attributes and other hyphenated attributes need setAttribute.
      if(key.includes("-")) {

        element.setAttribute(key, value);
      } else {

        element[key] = value;
      }
    }

    // Add any children, handling both elements and text nodes. Text strings are automatically converted to text nodes for proper DOM insertion.
    for(const child of children) {

      element.appendChild((typeof child === "string") ? document.createTextNode(child) : child);
    }

    return element;
  }

  /**
   * Toggle CSS classes on an element more elegantly.
   *
   * This utility helps manage the common pattern of adding and removing classes based on state changes, particularly useful for highlighting selected items.
   *
   * @param {HTMLElement} element - The element to modify.
   * @param {string[]} [add=[]] - Classes to add.
   * @param {string[]} [remove=[]] - Classes to remove.
   * @private
   */
  #toggleClasses(element, add = [], remove = []) {

    for(const cls of remove) {

      element.classList.remove(cls);
    }

    for(const cls of add) {

      element.classList.add(cls);
    }
  }

  /**
   * Hide the feature options webUI and clean up all resources.
   *
   * This hides the UI elements and calls cleanup to remove all event listeners and free resources. This method should be called when switching away from the
   * feature options view or when the plugin configuration UI is being destroyed.
   *
   * @returns {Promise<void>}
   * @public
   */
  hide() {

    // Hide the UI elements until we're ready to show them. This prevents visual flickering as we build the interface.
    for(const id of [ "deviceStatsContainer", "headerInfo", "optionsContainer", "search", "sidebar" ]) {

      const element = document.getElementById(id);

      if(element) {

        element.style.display = "none";
      }
    }

    this.cleanup();
  }

  /**
   * Show global options in the main content area.
   *
   * This displays the feature options that apply globally to all controllers and devices. It clears the devices container and resets the device list since
   * global options don't have associated devices.
   *
   * @private
   */
  #showGlobalOptions() {


    // Clear the devices container since global options don't have associated devices, but only when we have controllers defined.
    if(this.#getControllers) {

      this.#devicesContainer.textContent = "";
    }

    // Highlight the global options entry
    this.#highlightSelectedController(null);

    // Show global options
    this.#showDeviceOptions("Global Options");
  }

  /**
   * Show controller options by loading its devices and displaying the controller's configuration.
   *
   * This displays the feature options for a specific controller. It finds the controller by its serial number and loads its associated devices.
   *
   * @param {string} controllerSerial - The serial number of the controller to show options for.
   * @private
   */
  async #showControllerOptions(controllerSerial) {

    const entry = (await this.#getControllers())?.find(c => c.serialNumber === controllerSerial);

    if(!entry) {

      return;
    }

    await this.#showSidebar(entry);
  }

  /**
   * Render the feature options webUI.
   *
   * This is the main entry point for displaying the UI. It handles all initialization, loads the current configuration, and sets up the interface. The method
   * is async because it needs to fetch configuration data from Homebridge and potentially connect to network controllers.
   *
   * @returns {Promise<void>}
   * @public
   */
  async show() {

    // Show the beachball while we setup. The user needs feedback that something is happening during the async operations.
    homebridge.showSpinner();
    homebridge.hideSchemaForm();

    // Update our menu button states to show we're on the feature options page. This provides visual navigation feedback to the user.
    this.#updateMenuState();

    // Show the feature options page and hide the support page. These are mutually exclusive views in the Homebridge UI.
    document.getElementById("pageSupport").style.display = "none";
    document.getElementById("pageFeatureOptions").style.display = "block";

    // Hide the UI elements and cleanup any listeners until we're ready to show them. This prevents visual flickering as we build the interface.
    this.hide();

    // Make sure we have the refreshed configuration. This ensures we're always working with the latest saved settings.
    this.currentConfig = await homebridge.getPluginConfig();

    // Keep our revert snapshot aligned with whatever was *last saved* (not just first render).
    // We compare to the current config and update the snapshot if it differs, so "Revert to Saved" reflects the latest saved state.
    const loadedOptions = (this.currentConfig[0]?.options ?? []);

    if(!this.#initialFeatureOptions || !this.#sameStringArray(this.#initialFeatureOptions, loadedOptions)) {

      this.#initialFeatureOptions = [...loadedOptions];
    }

    // Retrieve the set of feature options available to us. This comes from the plugin backend and defines what options can be configured.
    const features = (await homebridge.request("/getOptions")) ?? [];

    // Initialize our feature option configuration. This creates the data structure that manages option states and hierarchies.
    this.#featureOptions = new FeatureOptions(features.categories, features.options, this.currentConfig[0].options ?? []);

    // Clear all our containers to start fresh. This ensures no stale content remains from previous displays.
    this.#clearContainers();

    // Ensure the DOM is ready before we render our UI. We wait for Bootstrap styles to be applied before proceeding.
    await this.#waitForBootstrap();

    // Initialize theme sync before injecting styles so CSS variables are defined and current.
    await this.#setupThemeAutoUpdate();

    // Add our custom styles for hover effects, dark mode support, and modern layouts. These enhance the visual experience and ensure consistency with the
    // Homebridge UI theme.
    this.#injectCustomStyles();

    // Initialize event delegation for all UI interactions.
    this.#initializeEventDelegation();

    // Hide the search panel initially until content is loaded.
    if(this.#searchPanel) {

      this.#searchPanel.style.display = "none";
    }

    // Check if we have controllers configured when they're required. We can't show device options without at least one controller in controller mode.
    if(this.#getControllers && !(await this.#getControllers())?.length) {

      this.#showNoControllersMessage();
      homebridge.hideSpinner();

      return;
    }

    // Initialize our informational header with feature option precedence information. This helps users understand the inheritance hierarchy.
    this.#initializeHeader();

    // Build the sidebar with global options and controllers/devices. This creates the navigation structure for the UI.
    await this.#buildSidebar();

    // All done. Let the user interact with us.
    homebridge.hideSpinner();

    // Default the user to the global settings if we have no controllers. Otherwise, show the first controller to give them a starting point.
    await this.#showSidebar((await this.#getControllers?.())?.[0] ?? null);
  }

  /**
   * Wait for Bootstrap to finish loading in the DOM so we can render our UI properly, or until the timeout expires.
   *
   * This ensures that we've loaded all the CSS resources needed to provide our visual interface. If Bootstrap doesn't load within the timeout period, we
   * proceed anyway to avoid blocking the UI indefinitely.
   *
   * @param {number} [timeoutMs=2000] - Maximum time to wait for Bootstrap in milliseconds.
   * @param {number} [intervalMs=20] - Interval between checks in milliseconds.
   * @returns {Promise<boolean>} True if Bootstrap was detected, false if timeout was reached.
   * @private
   */
  async #waitForBootstrap(timeoutMs = 2000, intervalMs = 20) {

    // Record when we started so we know how long we have been waiting.
    const startTime = Date.now();

    // This helper checks whether Bootstrap's styles are currently applied.
    const isBootstrapApplied = () => {

      // We create a temporary test element and apply the "d-none" class.
      const testElem = document.createElement("div");

      testElem.className = "d-none";
      document.body.appendChild(testElem);

      // If Bootstrap is loaded, the computed display value should be "none".
      const display = getComputedStyle(testElem).display;

      // Remove our test element to avoid leaving behind clutter.
      document.body.removeChild(testElem);

      // Return true if the Bootstrap style is detected.
      return display === "none";
    };

    // We loop until Bootstrap is detected or we reach our timeout.
    while(Date.now() - startTime < timeoutMs) {

      // If Bootstrap is active, we can stop waiting.
      if(isBootstrapApplied()) {

        return true;
      }

      // Otherwise, we pause for a short interval before checking again.
      // eslint-disable-next-line no-await-in-loop
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }

    return false;
  };

  /**
   * Update the menu button states to reflect the current page.
   *
   * This provides visual feedback about which section of the plugin config the user is currently viewing. We swap between the elegant and primary button
   * styles to show active/inactive states.
   *
   * @private
   */
  #updateMenuState() {

    const menuStates = [
      { id: "menuHome", primary: true },
      { id: "menuFeatureOptions", primary: false },
      { id: "menuSettings", primary: true }
    ];

    for(const { id, primary } of menuStates) {

      this.#toggleClasses(document.getElementById(id),
        primary ? ["btn-primary"] : ["btn-elegant"],
        primary ? ["btn-elegant"] : ["btn-primary"]);
    }
  }

  /**
   * Clear all containers to prepare for fresh content.
   *
   * This ensures we don't have any stale data when switching between controllers or refreshing the view. We also reset our controller and device lists to
   * maintain consistency between the UI state and the displayed content.
   *
   * @private
   */
  #clearContainers() {

    for(const id of [ "controllersContainer", "devicesContainer", "configTable" ]) {

      const container = document.getElementById(id);

      if(container) {

        container.textContent = "";
      }
    }
  }

  /**
   * Show a message when no controllers are configured.
   *
   * This provides clear guidance to the user about what they need to do before they can configure feature options. Without controllers, there's nothing to
   * configure in controller mode.
   *
   * @private
   */
  #showNoControllersMessage() {

    const headerInfo = document.getElementById("headerInfo");

    headerInfo.textContent = "Please configure a controller to access in the main settings tab before configuring feature options.";
    headerInfo.style.display = "";
  }

  /**
   * Initialize the informational header showing feature option precedence.
   *
   * This header educates users about how options inherit through the hierarchy. Understanding this inheritance model is crucial for effective configuration,
   * so we make it prominent at the top of the interface. The header adapts based on whether controllers are being used.
   *
   * @private
   */
  #initializeHeader() {

    const headerInfo = document.getElementById("headerInfo");

    headerInfo.style.fontWeight = "bold";
    headerInfo.innerHTML = "Feature options are applied in prioritized order, from global to device-specific options:" +
      "<br><i class=\"text-warning\">Global options</i> (lowest priority) &rarr; " +
      (this.#getControllers ? "<i class=\"text-success\">Controller options</i> &rarr; " : "") +
      "<i class=\"text-info\">Device options</i> (highest priority)";
  }

  /**
   * Build the sidebar with global options and controllers.
   *
   * The sidebar provides the primary navigation for the feature options UI. It always includes a global options entry and optionally includes controllers if
   * the plugin is configured to use them. The sidebar structure determines how users navigate between different configuration scopes.
   *
   * @private
   */
  async #buildSidebar() {

    // Create the global options entry - this is always present. Global options apply to all devices and provide baseline configuration.
    this.#createGlobalOptionsEntry(this.#controllersContainer);

    // Create controller entries if we're using controllers. Controllers provide an intermediate level of configuration between global and device-specific.
    if(this.#getControllers) {

      await this.#createControllerEntries(this.#controllersContainer);
    }
  }

  /**
   * Create the global options entry in the sidebar.
   *
   * Global options are always available and provide the baseline configuration that all controllers and devices inherit from. This entry is styled differently
   * to indicate its special status and is added to the appropriate tracking list based on whether controllers are present.
   *
   * @param {HTMLElement} controllersContainer - The container to add the entry to.
   * @private
   */
  #createGlobalOptionsEntry(controllersContainer) {

    const globalLink = this.#createElement("a", {

      classList: [ "nav-link", "nav-header", "text-decoration-none", "text-uppercase", "fw-bold" ],
      "data-navigation": "global",
      href: "#",
      name: "Global Options",
      role: "button"
    }, ["Global Options"]);

    controllersContainer.appendChild(globalLink);
  }

  /**
   * Create controller entries in the sidebar.
   *
   * Controllers represent network devices that manage multiple accessories. Each controller gets its own entry in the sidebar, allowing users to configure
   * options at the controller level that apply to all its devices. Controllers are displayed with their configured names for easy identification.
   *
   * @param {HTMLElement} controllersContainer - The container to add entries to.
   * @private
   */
  async #createControllerEntries(controllersContainer) {

    // If we don't have controllers defined, we're done.
    if(!this.#getControllers) {

      return;
    }

    // Create the controller category header. This visually groups all controllers together and uses the configured label.
    const categoryHeader = this.#createElement("h6", {

      classList: [ "nav-header", "text-muted", "text-uppercase", "small", "mb-1" ]
    }, [this.#sidebar.controllerLabel]);

    controllersContainer.appendChild(categoryHeader);

    // Create an entry for each controller. Controllers are identified by their serial number and displayed with their friendly name.
    for(const controller of (await this.#getControllers())) {

      const link = this.#createElement("a", {

        classList: [ "nav-link", "text-decoration-none" ],
        "data-device-serial": controller.serialNumber,
        "data-navigation": "controller",
        href: "#",
        name: controller.serialNumber,
        role: "button"
      }, [controller.name]);

      controllersContainer.appendChild(link);
    }
  }

  /**
   * Show the device list taking the controller context into account.
   *
   * This method handles the navigation when a user clicks on a controller or global options in the sidebar. It loads the appropriate devices and displays the
   * feature options for the selected context. For controllers, it loads devices from the network. For global options, it shows global configuration.
   *
   * @param {Controller|null} controller - The controller to show devices for, or null for global options.
   * @returns {Promise<void>}
   * @private
   */
  async #showSidebar(controller) {

    // Show the beachball while we setup. Loading devices from a controller can take time, especially over the network.
    homebridge.showSpinner();

    // Grab the list of devices we're displaying. This might involve a network request to the controller or reading from the Homebridge cache.
    this.#devices = await this.#getDevices(controller);

    if(this.#getControllers) {

      // Highlight the selected controller. This provides visual feedback about which controller's devices we're currently viewing.
      this.#highlightSelectedController(controller);

      // Handle connection errors. If we can't connect to a controller, we need to inform the user rather than showing an empty list.
      if(controller && !this.#devices?.length) {

        await this.#showConnectionError();

        return;
      }

      // The first entry returned by getDevices() must always be the controller. This convention allows us to show controller-specific options.
      this.#controller = this.#devices[0]?.serialNumber ?? null;
    }

    // Make the UI visible. Now that we have our data, we can show the interface elements to the user.
    for(const id of ["headerInfo"]) {

      const element = document.getElementById(id);

      if(element) {

        element.style.display = "";
      }
    }

    // The sidebar should always be visible unless there's an error.
    const sidebar = document.getElementById("sidebar");

    if(sidebar) {

      sidebar.style.display = "";
    }

    // Clear and populate the devices container. #showSidebarDevices is responsible for the actual display logic.
    this.#devicesContainer.textContent = "";
    this.#showSidebarDevices(controller, this.#devices);

    // Display the feature options to the user. For controllers, we show the controller's options. For global context, we show global options.
    this.#showDeviceOptions(controller ? this.#devices[0].serialNumber : "Global Options");

    // All done. Let the user interact with us.
    homebridge.hideSpinner();
  }

  /**
   * Highlight the selected controller in the sidebar.
   *
   * This provides visual feedback about which controller is currently selected. We use the active class to indicate selection, which works well in both
   * light and dark modes thanks to our custom styles. The highlighting helps users maintain context as they navigate.
   *
   * @param {Controller|null} controller - The selected controller, or null for global options.
   * @private
   */
  #highlightSelectedController(controller) {

    const selectedName = controller?.serialNumber ?? "Global Options";

    for(const entry of document.querySelectorAll("#sidebar .nav-link[data-navigation]")) {

      this.#toggleClasses(entry, (entry.name === selectedName) ? ["active"] : [], (entry.name === selectedName) ? [] : ["active"]);
    }
  }

  /**
   * Show a connection error message with retry capability.
   *
   * When we can't connect to a controller, we need to provide clear feedback about what went wrong. This helps users troubleshoot configuration issues. The
   * error message includes details from the backend and offers a retry button after a short delay.
   *
   * @returns {Promise<void>}
   * @private
   */
  async #showConnectionError() {

    // Hide the sidebar and other UI elements that don't make sense without a connection.
    const sidebar = document.getElementById("sidebar");

    if(sidebar) {

      sidebar.style.display = "none";
    }

    if(this.#deviceStatsContainer) {

      this.#deviceStatsContainer.style.display = "none";
    }

    if(this.#searchPanel) {

      this.#searchPanel.style.display = "none";
    }

    // Clear all containers to remove any stale content.
    this.#clearContainers();

    const headerInfo = document.getElementById("headerInfo");

    const errorMessage = [

      "Unable to connect to the controller.",
      "Check the Settings tab to verify the controller details are correct.",
      "<code class=\"text-danger\">" + (await homebridge.request("/getErrorMessage")) + "</code>"
    ].join("<br>") + "<br>";

    // Create a container div for the error message and future retry button. This allows us to add the button without replacing the entire content.
    const errorContainer = this.#createElement("div", {}, []);

    errorContainer.innerHTML = errorMessage;
    headerInfo.textContent = "";
    headerInfo.appendChild(errorContainer);
    headerInfo.style.display = "";

    // Wrapper that shrink-wraps its children
    const retryWrap = this.#createElement("div", { classList: "d-inline-block w-auto" });

    // Create the retry button with consistent styling. We use the warning style to indicate this is a recovery action.
    const retryButton = this.#createElement("button", {

      classList: "btn btn-warning btn-sm mt-3",
      textContent: "\u21BB Retry",
      type: "button"
    });

    retryButton.disabled = true;

    // Add the button to the error container. It appears below the error message with appropriate spacing.
    retryWrap.appendChild(retryButton);

    // Add a slim progress bar that fills for 5s.
    const barWrap = this.#createElement("div", {

      classList: "progress mt-1 w-100",
      style: { height: "4px" }
    }, [

      this.#createElement("div", {

        classList: "progress-bar",
        role: "progressbar",
        style: { width: "0%" }
      })
    ]);

    retryWrap.appendChild(barWrap);
    errorContainer.appendChild(retryWrap);

    // Kick off the fill animation on the next frame
    const bar = barWrap.querySelector(".progress-bar");

    bar.style.setProperty("--bs-progress-bar-bg", this.#themeColor.background);

    window.requestAnimationFrame(() => {

      bar.style.transition = "width " + this.#ui.controllerRetryEnableDelayMs + "ms linear";
      bar.style.width = "100%";
    });

    // After five seconds, enable the retry button. The delay prevents the UI from appearing too busy immediately after an error and gives users time to read the
    // error message before seeing the action they can take.
    setTimeout(() => {

      retryButton.disabled = false;
      barWrap.remove();

      // Set up the retry handler. When clicked, we'll refresh the entire UI which will retry all connections and rebuild the interface.
      this.#addEventListener(retryButton, "click", async () => {

        // Provide immediate feedback that we're retrying. The button becomes disabled to prevent multiple simultaneous retry attempts.
        retryButton.disabled = true;
        retryButton.textContent = "Retrying...";

        // Refresh our UI which will force a reconnection.
        this.cleanup();
        await this.show();
      });
    }, this.#ui.controllerRetryEnableDelayMs);

    homebridge.hideSpinner();
  }

  /**
   * Show feature option information for a specific device, controller, or globally.
   *
   * This is the main method for displaying feature options. It handles all three contexts (global, controller, device) and builds the appropriate UI elements
   * including search, filters, and the option tables themselves. The display adapts based on the current scope and available options.
   *
   * @param {string} deviceId - The device serial number, or "Global Options" for global context.
   * @public
   */
  #showDeviceOptions(deviceId) {

    homebridge.showSpinner();

    // Clean up event listeners from previous option displays. This ensures we don't accumulate listeners as users navigate between devices.
    this.#cleanupOptionEventListeners();

    // Update the selected device highlighting. This provides visual feedback in the sidebar about which device's options are being displayed.
    this.#highlightSelectedDevice(deviceId);

    // Find the current device and update the info panel. The info panel shows device-specific information like firmware version and serial number.
    const currentDevice = this.#devices.find(device => device.serialNumber === deviceId);

    this.#updateDeviceInfoPanel(currentDevice);

    // Clear the configuration table for fresh content. We rebuild the entire option display for each device to ensure accuracy.
    this.#configTable.textContent = "";

    // Initialize the search UI if it exists. The search UI includes the search box, filters, and status information.
    this.#initializeSearchUI();

    // Create option tables for each category. Categories group related options together for better organization.
    this.#createOptionTables(currentDevice);

    // Set up search functionality if available. This includes debounced search and keyboard shortcuts.
    this.#setupSearchFunctionality();

    // Display the table.
    document.getElementById("optionsContainer").style.display = "";

    homebridge.hideSpinner();
  }

  /**
   * Clean up event listeners specific to option displays.
   *
   * When switching between devices, we need to clean up listeners attached to option elements. We identify these by checking if they're within the config
   * table, preserving sidebar navigation listeners. This prevents memory leaks from accumulating listeners.
   *
   * @private
   */
  #cleanupOptionEventListeners() {

    // Remove listeners that are specific to options (not sidebar navigation). We build a list first to avoid modifying the map while iterating.
    const keysToRemove = [];

    for(const [ key, listener ] of this.#eventListeners.entries()) {

      // Identify option-specific listeners by checking if they're on config table elements. The closest method will find the config table if the element is
      // within it.
      if(listener.element.closest && listener.element.closest("#configTable")) {

        keysToRemove.push(key);
      }
    }

    // Remove the identified listeners. We do this as a separate step to avoid iterator invalidation issues.
    for(const key of keysToRemove) {

      this.#removeEventListener(key);
    }
  }

  /**
   * Highlight the selected device in the sidebar.
   *
   * Similar to controller highlighting, this provides visual feedback about which device's options are currently being displayed. The highlighting helps users
   * maintain context as they navigate through multiple devices.
   *
   * @param {string} deviceId - The serial number of the selected device.
   * @private
   */
  #highlightSelectedDevice(deviceId) {

    // cover both device links and the single "Global Options" link
    const links = document.querySelectorAll("#sidebar .nav-link[data-navigation='device'], " + "#sidebar .nav-link[data-navigation='global']");

    for(const entry of links) {

      const shouldBeActive = entry.name === deviceId;

      this.#toggleClasses(entry, shouldBeActive ? ["active"] : [], shouldBeActive ? [] : ["active"]);
    }
  }

  /**
   * Update the device information panel with device-specific details.
   *
   * The info panel shows device-specific details using a responsive grid layout. We hide it for global context since there's no specific device to show
   * information about. The panel content is customizable through the infoPanel configuration option.
   *
   * @param {Device|undefined} device - The device to show information for.
   * @private
   */
  #updateDeviceInfoPanel(device) {

    // Ensure we've got the device statistics container available.
    if(!this.#deviceStatsContainer) {

      return;
    }

    this.#deviceStatsContainer.style.display = device ? "" : "none";
    this.#infoPanel(device);
  }

  /**
   * Initialize the search UI components including search bar, filters, and status display.
   *
   * The search UI provides powerful filtering capabilities for finding specific options. It includes a search box, filter buttons, and status information about
   * the current view. The UI is rebuilt fresh each time to ensure it reflects the current option set.
   *
   * @private
   */
  #initializeSearchUI() {

    if(!this.#searchPanel) {

      return;
    }

    // Clear existing content. We rebuild the search UI fresh each time to ensure it reflects the current option set.
    this.#searchPanel.textContent = "";
    this.#searchPanel.className = "";

    // Create the status bar. This shows counts and provides a reset button.
    const statusBar = this.#createStatusBar();

    this.#searchPanel.appendChild(statusBar);

    // Create the main control bar. This contains the search input and filters.
    const controlBar = this.#createControlBar();

    this.#searchPanel.appendChild(controlBar);
    this.#searchPanel.style.display = "";
  }

  /**
   * Create the status bar showing option counts and reset button.
   *
   * The status bar provides at-a-glance information about how many options are available, how many have been modified, and how many match current filters. It
   * also provides a convenient compound reset button that reveals different reset options when clicked.
   *
   * @returns {HTMLElement} The status bar element.
   * @private
   */
  #createStatusBar() {

    const statusInfo = this.#createElement("div", {

      id: "statusInfo",
      style: { flex: "1 1 auto", minWidth: "0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }
    }, [
      this.#createElement("span", { classList: "text-muted" }, [
        this.#createElement("strong", {}, ["0"]),
        " total options \u00B7 ",
        this.#createElement("strong", { classList: "text-warning" }, ["0"]),
        " modified \u00B7 ",
        this.#createElement("strong", { classList: "text-info" }, ["0"]),
        " grouped \u00B7 ",
        this.#createElement("strong", { classList: "text-success" }, ["0"]),
        " visible"
      ])
    ]);

    const resetBtn = this.#createResetButton();

    return this.#createElement("div", {

      classList: "d-flex justify-content-between align-items-center px-2 py-1 mb-1 alert-info rounded",
      id: "featureStatusBar",
      style: { alignItems: "center", display: "flex", fontSize: "0.8125rem", gap: "0.5rem" }
    }, [ statusInfo, resetBtn ]);
  }

  /**
   * Create a compound reset button group with multiple reset options.
   *
   * The reset button initially displays as "Reset...". When clicked, it reveals two action buttons: "Reset to Defaults" and "Revert to Saved". This gives
   * users the ability to choose between clearing all options or reverting to the last saved state.
   *
   * @returns {HTMLElement} The reset button container.
   * @private
   */
  #createResetButton() {

    const resetContainer = this.#createElement("div", {

      classList: [ "d-flex", "align-items-center", "gap-1" ],
      role: "group"
    });

    // Primary reset button that toggles the action buttons.
    const toggleBtn = this.#createElement("button", {

      classList: "btn btn-xs btn-outline-danger cursor-pointer text-truncate user-select-none",
      "data-action": "reset-toggle",
      style: { fontSize: "0.75rem", marginLeft: "auto", padding: "0.25rem 0.5rem" },
      textContent: "Reset...",
      title: "Configuration reset options.",
      type: "button"
    });

    // Reset to defaults button.
    const resetDefaultsBtn = this.#createElement("button", {

      classList: "btn btn-xs btn-outline-danger cursor-pointer d-none text-truncate user-select-none",
      "data-action": "reset-defaults",
      style: { fontSize: "0.75rem", marginLeft: "auto", padding: "0.25rem 0.5rem" },
      textContent: "Reset to Defaults",
      title: "Reset all options to default values.",
      type: "button"
    });

    // Revert to saved button.
    const revertBtn = this.#createElement("button", {

      classList: "btn btn-xs btn-outline-danger cursor-pointer d-none text-truncate user-select-none",
      "data-action": "reset-revert",
      style: { fontSize: "0.75rem", marginLeft: "auto", padding: "0.25rem 0.5rem" },
      textContent: "Revert to Saved",
      title: "Revert options to the last saved configuration.",
      type: "button"
    });

    resetContainer.appendChild(toggleBtn);
    resetContainer.appendChild(resetDefaultsBtn);
    resetContainer.appendChild(revertBtn);

    return resetContainer;
  }

  /**
   * Revert all options to the originally saved feature options.
   *
   * This restores the configuration to the state it was in when the UI was first shown. This is useful for undoing changes without losing the previously saved
   * configuration. The UI is refreshed to reflect the reverted state.
   *
   * @returns {Promise<void>}
   * @private
   */
  async #revertToInitialOptions() {

    homebridge.showSpinner();

    // Restore the initial options we saved during the first render or after the last detected save.
    this.currentConfig[0].options = [...this.#initialFeatureOptions];
    this.#featureOptions.configuredOptions = [...this.#initialFeatureOptions];

    await homebridge.updatePluginConfig(this.currentConfig);

    const selectedDevice = this.#devicesContainer.querySelector("a[data-navigation='device'].active");

    this.#showDeviceOptions(selectedDevice?.name ?? "Global Options");

    homebridge.hideSpinner();

    this.#showRevertSuccessMessage();
  }

  /**
   * Show a success message after reverting to saved configuration.
   *
   * This provides feedback that the revert action completed successfully. The message auto-dismisses to avoid cluttering the UI.
   *
   * @private
   */
  #showRevertSuccessMessage() {

    const statusBar = document.getElementById("featureStatusBar");

    if(!statusBar) {

      return;
    }

    const successMsg = this.#createElement("div", {

      classList: "alert alert-info alert-dismissible fade show mt-2",
      innerHTML: "<strong>Options have been reverted to the last saved configuration.</strong>" +
        "<button type=\"button\" class=\"btn-close\" data-bs-dismiss=\"alert\" aria-label=\"Close\"></button>",
      role: "alert"
    });

    statusBar.insertAdjacentElement("afterend", successMsg);

    setTimeout(() => {

      successMsg.classList.remove("show");
      setTimeout(() => successMsg.remove(), 150);
    }, 3000);
  }

  /**
   * Create the main control bar with search input and filter buttons.
   *
   * The control bar contains the primary interaction elements for filtering and searching options. It uses a responsive flexbox layout that adapts to different
   * screen sizes while maintaining usability.
   *
   * @returns {HTMLElement} The control bar element.
   * @private
   */
  #createControlBar() {

    return this.#createElement("div", {

      classList: ["search-toolbar"]
    }, [
      this.#createElement("div", {

        classList: [ "d-flex", "flex-wrap", "gap-2", "align-items-center" ]
      }, [
        this.#createSearchInput(),
        this.#createFilterPills(),
        this.#createElement("div", {

          classList: [ "ms-auto", "d-flex", "gap-2" ]
        }, [
          this.#createExpandToggle()
        ])
      ])
    ]);
  }

  /**
   * Create the search input with Bootstrap input group styling.
   *
   * The search input uses Bootstrap's input group component for a more polished appearance. It includes proper responsive sizing and autocomplete disabled to
   * prevent browser suggestions from interfering with the search experience.
   *
   * @returns {HTMLElement} The search input wrapper.
   * @private
   */
  #createSearchInput() {

    const searchInput = this.#createElement("input", {

      autocomplete: "off",
      classList: ["form-control"],
      id: "searchInput",
      placeholder: "Search options...",
      type: "search"
    });

    return this.#createElement("div", {

      classList: [ "search-input-wrapper", "flex-grow-1" ],
      style: { maxWidth: "400px" }
    }, [
      this.#createElement("div", {

        classList: ["input-group"]
      }, [
        searchInput
      ])
    ]);
  }

  /**
   * Create filter pills for quick filtering of options.
   *
   * Filter pills provide a modern alternative to button groups. They're easier to tap on mobile devices and provide clearer visual separation. Currently
   * supports "All" and "Modified" filters with room for expansion.
   *
   * @returns {HTMLElement} The filter pills container.
   * @private
   */
  #createFilterPills() {

    const filterContainer = this.#createElement("div", {

      classList: [ "filter-pills", "d-flex", "gap-1" ]
    });

    const filters = [
      { active: true, class: "btn-primary", id: "filter-all", text: "All", title: "Show all options." },
      { active: false, class: "btn-warning text-dark", id: "filter-modified", text: "Modified", title: "Show only modified options." }
    ];

    for(const filter of filters) {

      filterContainer.appendChild(this.#createFilterButton(filter));
    }

    return filterContainer;
  }

  /**
   * Create a filter button with proper styling and attributes.
   *
   * Each filter button represents a different view of the options. Only one filter can be active at a time, and clicking a filter immediately updates the
   * displayed options. The buttons use data attributes to store their configuration.
   *
   * @param {Object} config - The filter button configuration.
   * @param {string} config.id - The button ID.
   * @param {string} config.text - The button text.
   * @param {string} config.class - The CSS classes for active state.
   * @param {boolean} config.active - Whether this filter is initially active.
   * @param {string} config.title - The tooltip text.
   * @returns {HTMLButtonElement} The filter button element.
   * @private
   */
  #createFilterButton(config) {

    const button = this.#createElement("button", {

      classList: [ "btn", "btn-xs", "cursor-pointer", "user-select-none", ...(config.active ? config.class.split(" ") : ["btn-outline-secondary"]) ],
      "data-filter": config.text.toLowerCase(),
      "data-filter-type": config.filter ?? config.text.toLowerCase(),
      id: config.id,
      style: { fontSize: "0.75rem", padding: "0.125rem 0.5rem" },
      textContent: config.text,
      title: config.title,
      type: "button"
    });

    return button;
  }

  /**
   * Handle filter button clicks to update the active filter and refresh the display.
   *
   * When a filter is clicked, we update the visual state of all filter buttons and apply the selected filter to the option display. This provides immediate
   * feedback about what's being shown. Only one filter can be active at a time.
   *
   * @param {HTMLButtonElement} button - The clicked button.
   * @param {Object} config - The button's configuration including class and filter type.
   * @private
   */
  #handleFilterClick(button, config) {

    // Reset all filter buttons. Only one can be active at a time.
    const filterContainer = button.parentElement;

    for(const btn of [...filterContainer.querySelectorAll("button")]) {

      btn.classList.remove("btn-primary", "btn-warning", "btn-info", "text-dark");
      btn.classList.add("btn-outline-secondary");
    }

    // Apply active styling to clicked button. We restore the original classes that indicate this filter is active.
    button.classList.remove("btn-outline-secondary");

    for(const cls of config.class.split(" ")) {

      button.classList.add(cls);
    }

    // Apply the filter. This updates the visibility of all option rows.
    this.#applyFilter(button.getAttribute("data-filter"));
  }

  /**
   * Create the expand/collapse toggle button for category management.
   *
   * This button provides a quick way to expand or collapse all option categories at once. It dynamically updates its state based on whether more categories
   * are expanded or collapsed. The button shows an arrow indicator that changes direction based on its action.
   *
   * @returns {HTMLElement} The toggle button container.
   * @private
   */
  #createExpandToggle() {

    const toggleBtn = this.#createElement("button", {

      classList: "btn btn-xs btn-outline-secondary",
      id: "toggleAllCategories",
      style: { display: "inline-block", fontFamily: "ui-monospace", fontSize: "0.75rem", padding: "0.125rem 0.5rem", textAlign: "center" },
      type: "button"
    });

    // Attach the update function to the button for external access. This allows other parts of the code to trigger a state update when categories change.
    toggleBtn.updateState = () => this.#updateToggleButtonState(toggleBtn);
    toggleBtn.updateState();

    return toggleBtn;
  }

  /**
   * Update the toggle button state based on category visibility.
   *
   * The button shows different icons and tooltips depending on whether it will expand or collapse categories when clicked. This provides clear feedback about
   * what action will be taken. The decision is based on whether more than half of the categories are currently expanded.
   *
   * @param {HTMLButtonElement} toggleBtn - The toggle button to update.
   * @private
   */
  #updateToggleButtonState(toggleBtn) {

    const tbodies = document.querySelectorAll("#configTable tbody");
    const expandedCount = [...tbodies].filter(tbody => tbody.style.display !== "none").length;
    const shouldShowCollapse = expandedCount > (tbodies.length / 2);

    toggleBtn.textContent = shouldShowCollapse ? "\u25B6" : "\u25BC";
    toggleBtn.title = shouldShowCollapse ? "Collapse all categories" : "Expand all categories";
    toggleBtn.setAttribute("data-action", shouldShowCollapse ? "collapse" : "expand");
  }

  /**
   * Handle toggle button clicks to expand or collapse all categories.
   *
   * When clicked, the toggle button expands or collapses all categories based on its current state. This provides a quick way to get an overview of all
   * options or focus on specific categories. The arrow indicators in each category header are updated to match.
   *
   * @param {HTMLButtonElement} toggleBtn - The toggle button.
   * @private
   */
  #handleToggleClick(toggleBtn) {

    const shouldExpand = toggleBtn.getAttribute("data-action") === "expand";

    for(const tbody of [...document.querySelectorAll("#configTable tbody")]) {

      tbody.style.display = shouldExpand ? "table-row-group" : "none";

      const indicator = tbody.parentElement.querySelector("thead span");

      if(indicator) {

        indicator.textContent = shouldExpand ? "\u25BC " : "\u25B6 ";
      }

      // Keep accessibility state synchronized for each category header.
      const headerCell = tbody.parentElement.querySelector("thead th[role='button']");

      if(headerCell) {

        headerCell.setAttribute("aria-expanded", shouldExpand ? "true" : "false");
      }
    }

    toggleBtn.updateState();
  }

  /**
   * Create option tables for each category that has valid options for the current device.
   *
   * This method creates the main content of the feature options display. Each category gets its own collapsible table containing all relevant options for the
   * current device context. Categories without valid options are skipped to keep the UI clean.
   *
   * @param {Device|undefined} currentDevice - The device to show options for.
   * @private
   */
  #createOptionTables(currentDevice) {

    for(const category of this.#featureOptions.categories) {

      // Skip invalid categories for this device. The UI configuration can filter out categories that don't apply to certain device types.
      if(!this.#ui.validOptionCategory(currentDevice, category)) {

        continue;
      }

      const optionTable = this.#createCategoryTable(category, currentDevice);

      if(optionTable) {

        this.#configTable.appendChild(optionTable);
      }
    }
  }

  /**
   * Create a single category table with all its options.
   *
   * Each category table is collapsible and contains all options for that category that are valid for the current device. Options are displayed with checkboxes
   * and optional value inputs. The table is only created if there are visible options to display.
   *
   * @param {Category} category - The category to create a table for.
   * @param {Device|undefined} currentDevice - The current device context.
   * @returns {HTMLTableElement|null} The created table, or null if no options are visible.
   * @private
   */
  #createCategoryTable(category, currentDevice) {

    // Create a unique id for the tbody so that the header can reference it for accessibility.
    const tbodyId = "tbody-" + category.name.replace(/\s+/g, "-");

    const tbody = this.#createElement("tbody", {

      classList: [ "border", "category-border" ],
      id: tbodyId,
      style: { display: "none" }
    });

    let visibleOptionsCount = 0;

    // Create rows for each option in this category. We filter out options that aren't valid for the current device context.
    for(const option of this.#featureOptions.options[category.name]) {

      // Skip invalid options for this device. The UI configuration determines which options are appropriate for each device type.
      if(!this.#ui.validOption(currentDevice, option)) {

        continue;
      }

      const optionRow = this.#createOptionRow(category, option, currentDevice);

      tbody.appendChild(optionRow);

      // Count visible options. Grouped options might be hidden initially if their parent option is disabled.
      if(optionRow.style.display !== "none") {

        visibleOptionsCount++;
      }
    }

    // Don't create the table if there are no visible options. This keeps the UI clean by not showing empty categories.
    if(!visibleOptionsCount) {

      return null;
    }

    // Create the complete table. We use Bootstrap table classes for consistent styling with the Homebridge UI.
    const table = this.#createElement("table", {

      classList: [ "table", "table-borderless", "table-sm", "table-hover" ],
      "data-category": category.name
    });

    // Create and add the header. The header shows the category name and scope information.
    const thead = this.#createCategoryHeader(category, currentDevice, tbodyId);

    table.appendChild(thead);
    table.appendChild(tbody);

    return table;
  }

  /**
   * Create the category header with scope indication.
   *
   * The header shows the category description and indicates the scope level (global, controller, or device). It's clickable to expand/collapse the category's
   * options. The scope label helps users understand at what level they're configuring options.
   *
   * @param {Category} category - The category information.
   * @param {Device|undefined} currentDevice - The current device context.
   * @param {string} tbodyId - The id of the tbody this header controls, for accessibility.
   * @returns {HTMLElement} The table header element.
   * @private
   */
  #createCategoryHeader(category, currentDevice, tbodyId) {

    const categoryIndicator = this.#createElement("span", {

      classList: "arrow",
      style: {

        display: "inline-block",
        fontFamily: "ui-monospace",
        marginRight: "4px",
        textAlign: "center",
        width: "1ch"
      }
    }, ["\u25B6 "]);

    const scopeLabel = !currentDevice ? " (Global)" : (this.#ui.isController(currentDevice) ? " (Controller-specific)" : " (Device-specific)");

    const th = this.#createElement("th", {

      "aria-controls": tbodyId,
      "aria-expanded": "false",
      classList: ["p-0"],
      colSpan: 3,
      role: "button",
      style: { cursor: "pointer", fontWeight: "bold" },
      tabIndex: 0,
      title: "Expand or collapse this category."
    }, [ categoryIndicator, category.description + scopeLabel ]);

    const thead = this.#createElement("thead", {}, [
      this.#createElement("tr", {}, [th])
    ]);

    return thead;
  }

  /**
   * Create a single option row with checkbox, label, and optional value input.
   *
   * Each option row contains a checkbox, label, and optional value input. The row handles the complex three-state checkbox logic and value inheritance through
   * the scope hierarchy. Grouped options are visually distinguished and initially hidden if their parent is disabled.
   *
   * @param {Category} category - The category this option belongs to.
   * @param {Option} option - The option configuration.
   * @param {Device|undefined} currentDevice - The current device context.
   * @returns {HTMLTableRowElement} The created table row.
   * @private
   */
  #createOptionRow(category, option, currentDevice) {

    const featureOption = this.#featureOptions.expandOption(category, option);

    const row = this.#createElement("tr", {

      classList: [ "align-top", ...((option.group !== undefined) ? ["grouped-option"] : []) ],
      id: "row-" + featureOption
    });

    // Create the checkbox cell. The checkbox shows the current state and handles user interactions.
    const checkboxCell = this.#createCheckboxCell(featureOption, option, currentDevice);

    row.appendChild(checkboxCell);

    // Create the label and optional input cells. Value-centric options get an additional input field for entering custom values.
    const { inputCell, labelCell } = this.#createLabelCells(featureOption, option, currentDevice, checkboxCell.querySelector("input"));

    if(inputCell) {

      row.appendChild(inputCell);
    }

    row.appendChild(labelCell);

    // Hide grouped options if their parent is disabled. Grouped options depend on their parent being enabled to be meaningful.
    if((option.group !== undefined) &&
      !this.#featureOptions.test(category.name + (option.group.length ? ("." + option.group) : ""), currentDevice?.serialNumber, this.#controller)) {

      row.style.display = "none";
    }

    return row;
  }

  /**
   * Create the checkbox cell for an option.
   *
   * The checkbox represents the option's state and supports three states: checked (enabled), unchecked (disabled), and indeterminate (inherited). The data
   * attributes store the device serial number for proper scope management.
   *
   * @param {string} featureOption - The expanded option name.
   * @param {Option} option - The option configuration.
   * @param {Device|undefined} currentDevice - The current device context.
   * @returns {HTMLTableCellElement} The checkbox cell.
   * @private
   */
  #createCheckboxCell(featureOption, option, currentDevice) {

    const checkbox = this.#createElement("input", {

      classList: "mx-2",
      "data-device-serial": currentDevice?.serialNumber ?? "",
      id: featureOption,
      name: featureOption,
      type: "checkbox",
      value: featureOption + (!currentDevice ? "" : ("." + currentDevice.serialNumber))
    });

    // Set initial checkbox state based on scope. This determines whether the option is set at this level or inherited from a higher scope.
    this.#initializeCheckboxState(checkbox, featureOption, option, currentDevice);

    return this.#createElement("td", {}, [checkbox]);
  }

  /**
   * Initialize checkbox state based on option scope and inheritance.
   *
   * This method implements the complex logic for determining initial checkbox state. Options can be set at global, controller, or device scope, and lower
   * scopes inherit from higher ones unless explicitly overridden. The indeterminate state indicates inheritance from a higher scope.
   *
   * @param {HTMLInputElement} checkbox - The checkbox element.
   * @param {string} featureOption - The expanded option name.
   * @param {Option} option - The option configuration.
   * @param {Device|undefined} currentDevice - The current device context.
   * @private
   */
  #initializeCheckboxState(checkbox, featureOption, option, currentDevice) {

    const scope = this.#featureOptions.scope(featureOption, currentDevice?.serialNumber, this.#controller);

    switch(scope) {

      case "global":
      case "controller":

        if(!currentDevice) {

          // We're at the global level - show the actual state. The indeterminate flag is explicitly set to false only when the checkbox is checked.
          checkbox.checked = this.#featureOptions.test(featureOption);

          if(checkbox.checked) {

            checkbox.indeterminate = false;
          }
        } else {

          // We're at a lower level but the option is set higher up. Show the indeterminate state to indicate inheritance.
          checkbox.readOnly = checkbox.indeterminate = true;
        }

        break;

      case "device":
      case "none":
      default:

        // The option is set at or below our current level. Show the actual state.
        checkbox.checked = this.#featureOptions.test(featureOption, currentDevice?.serialNumber);

        break;
    }

    checkbox.defaultChecked = option.default;
  }

  /**
   * Create the label and optional input cells for an option.
   *
   * The label shows the option description and is styled based on scope. Value-centric options also get an input field for entering custom values. The layout
   * adapts based on whether a custom input size is specified, with standard-sized inputs in separate cells and custom-sized inputs inline with the label.
   *
   * @param {string} featureOption - The expanded option name.
   * @param {Option} option - The option configuration.
   * @param {Device|undefined} currentDevice - The current device context.
   * @param {HTMLInputElement} checkbox - The checkbox for this option.
   * @returns {{labelCell: HTMLTableCellElement, inputCell: HTMLTableCellElement|null}} The created cells.
   * @private
   */
  #createLabelCells(featureOption, option, currentDevice, checkbox) {

    let inputValue = null;
    let inputCell = null;

    // Create input field for value-centric options. These options accept a custom value in addition to being enabled/disabled.
    if(this.#featureOptions.isValue(featureOption)) {

      const scope = this.#featureOptions.scope(featureOption, currentDevice?.serialNumber, this.#controller);
      let initialValue;

      // Determine the initial value based on scope. We need to fetch the value from the appropriate scope level to show inherited values correctly.
      switch(scope) {

        case "global":
        case "controller":

          if(!currentDevice) {

            // At global level, show the global value.
            initialValue = this.#featureOptions.value(featureOption);
          } else {

            // At lower level, show the value from the scope where it's set.
            initialValue = this.#featureOptions.value(featureOption, (scope === "controller") ? this.#controller : undefined);
          }

          break;

        case "device":
        case "none":
        default:

          // Show the device-specific value.
          initialValue = this.#featureOptions.value(featureOption, currentDevice?.serialNumber);

          break;
      }

      // Create the input element. We'll manage changes and updates through event delegation.
      inputValue = this.#createElement("input", {

        classList: "form-control shadow-none",
        readOnly: !checkbox.checked,
        style: {

          boxSizing: "content-box",
          fontFamily: "ui-monospace",
          width: (option.inputSize ?? 5) + "ch"
        },
        type: "text",
        value: initialValue ?? option.defaultValue
      });

      // Create separate cell for standard-sized inputs. Custom-sized inputs are placed inline with the label for better layout flexibility.
      if(option.inputSize === undefined) {

        inputCell = this.#createElement("td", {

          classList: "mr-2",
          style: { width: "10%" }
        }, [inputValue]);
      }
    }

    // Create the label. This shows the option description and handles click events for better UX.
    const label = this.#createOptionLabel(featureOption, option, currentDevice, checkbox);

    const labelCell = this.#createElement("td", {

      classList: [ "w-100", "option-label" ],
      colSpan: inputCell ? 1 : 2
    }, [
      ...((inputValue && !inputCell) ? [inputValue] : []),
      label
    ]);

    return { inputCell, labelCell };
  }

  /**
   * Create the option label element with proper styling and scope indication.
   *
   * The label displays the option description and is color-coded based on the option's scope. It uses the cursor-pointer class to indicate it's clickable and
   * the user-select-none class to prevent text selection during clicks.
   *
   * @param {string} featureOption - The expanded option name.
   * @param {Option} option - The option configuration.
   * @param {Device|undefined} currentDevice - The current device context.
   * @param {HTMLInputElement} checkbox - The checkbox for this option.
   * @returns {HTMLLabelElement} The label element.
   * @private
   */
  #createOptionLabel(featureOption, option, currentDevice, checkbox) {

    const label = this.#createElement("label", {

      classList: [ "user-select-none", "my-0", "py-0", "cursor-pointer" ],
      for: checkbox.id
    }, [option.description]);

    // Apply scope-based coloring. This provides visual feedback about where the option's current value is coming from in the hierarchy.
    const scopeColor = this.#featureOptions.color(featureOption, currentDevice?.serialNumber, currentDevice?.serialNumber ? this.#controller : undefined);

    label.classList.add(scopeColor || "text-body");

    return label;
  }

  /**
   * Handle option state changes with full hierarchy and dependency management.
   *
   * This is the core method that manages all option state transitions. It handles the three-state checkbox logic, updates the configuration, manages visual
   * states, and updates dependent options. This is where the complexity of the inheritance model is implemented.
   *
   * @param {HTMLInputElement} checkbox - The checkbox that changed.
   * @param {string} featureOption - The expanded option name.
   * @param {Option} option - The option configuration.
   * @param {Device|undefined} currentDevice - The current device context.
   * @param {HTMLLabelElement} label - The option label.
   * @param {HTMLInputElement|null} inputValue - The value input for value-centric options.
   * @returns {Promise<void>}
   * @private
   */
  async #handleOptionChange(checkbox, featureOption, option, currentDevice, label, inputValue) {

    // Remove existing option from configuration. We use a regex to match all variations of this option (Enable/Disable, with/without value).
    const optionRegex = new RegExp("^(?:Enable|Disable)\\." + checkbox.id + (!currentDevice ? "" : ("\\." + currentDevice.serialNumber)) + "(?:\\.([^\\.]*))?$", "gi");
    const newOptions = this.#featureOptions.configuredOptions.filter(entry => !optionRegex.test(entry));

    // Determine if option is set upstream. This affects whether we show the indeterminate state when unchecking.
    const upstreamOption = this.#hasUpstreamOption(checkbox.id, currentDevice);

    // Handle state transitions. This implements the three-state checkbox logic for proper inheritance display.
    this.#handleCheckboxStateTransition(checkbox, upstreamOption, option, inputValue, currentDevice);

    // Update configuration if needed. We only add configuration entries for options that differ from their defaults or have upstream settings.
    if(this.#shouldUpdateConfiguration(checkbox, option, inputValue, upstreamOption)) {

      this.#updateOptionConfiguration(checkbox, newOptions, inputValue, featureOption);
    }

    // Update our plugin configuration in Homebridge so they are ready to save.
    await this.#updatePluginConfiguration(newOptions);

    // Update visual state. Options that differ from defaults are highlighted to make it easy to see what's been customized.
    this.#updateOptionVisualState(checkbox, option, label, featureOption, currentDevice);

    // Handle dependent options. Grouped options need to be shown/hidden based on their parent option's state.
    this.#updateDependentOptions(checkbox, featureOption, currentDevice);

    // Update our status bar with current counts.
    this.#updateCounts([...document.querySelectorAll("#configTable tr[id^='row-']")]);
  }

  /**
   * Check if an option is set upstream in the hierarchy.
   *
   * This determines whether an option has a value set at a higher scope level. This information is used to determine whether to show the indeterminate state
   * when an option is unchecked at a lower level, indicating that it will inherit a value from above.
   *
   * @param {string} optionId - The option identifier.
   * @param {Device|undefined} currentDevice - The current device context.
   * @returns {boolean} True if the option is set at a higher scope level.
   * @private
   */
  #hasUpstreamOption(optionId, currentDevice) {

    if(!currentDevice) {

      return false;
    }

    const upstreamScope = this.#featureOptions.scope(optionId, (currentDevice.serialNumber !== this.#controller) ? this.#controller : undefined);

    switch(upstreamScope) {

      case "device":
      case "controller":

        return currentDevice.serialNumber !== this.#controller;

      case "global":
        return true;

      default:
        return false;
    }
  }

  /**
   * Handle checkbox state transitions between checked, unchecked, and indeterminate states.
   *
   * This implements the three-state checkbox logic. Checkboxes can be checked, unchecked, or indeterminate (inherited). The transitions between these states
   * follow specific rules based on the inheritance hierarchy. Value inputs are also managed based on the checkbox state.
   *
   * @param {HTMLInputElement} checkbox - The checkbox element.
   * @param {boolean} upstreamOption - Whether the option is set upstream.
   * @param {Option} option - The option configuration.
   * @param {HTMLInputElement|null} inputValue - The value input element.
   * @param {Device|undefined} currentDevice - The current device context.
   * @private
   */
  #handleCheckboxStateTransition(checkbox, upstreamOption, option, inputValue, currentDevice) {

    // Transitioning from indeterminate to unchecked. When the user clicks an indeterminate checkbox, it becomes unchecked, explicitly disabling the option
    // at this level.
    if(checkbox.readOnly) {

      checkbox.checked = checkbox.readOnly = false;

      if(inputValue) {

        inputValue.value = option.defaultValue;
        inputValue.readOnly = true;
        inputValue.disabled = true;
        inputValue.setAttribute("aria-disabled", "true");
      }

      return;
    }

    // Transitioning from checked to unchecked/indeterminate. If there's an upstream value, we show indeterminate to indicate inheritance.
    if(!checkbox.checked) {

      if(upstreamOption) {

        checkbox.readOnly = checkbox.indeterminate = true;
      }

      if(inputValue) {

        const inheritedValue = this.#getInheritedValue(checkbox.id, currentDevice);

        inputValue.value = inheritedValue ?? option.defaultValue;
        inputValue.readOnly = true;
        inputValue.disabled = true;
        inputValue.setAttribute("aria-disabled", "true");
      }

      return;
    }

    // Transitioning to checked. The option is explicitly enabled at this level, overriding any inherited values.
    checkbox.readOnly = checkbox.indeterminate = false;

    if(inputValue) {

      inputValue.readOnly = false;
      inputValue.disabled = false;
      inputValue.removeAttribute("aria-disabled");
    }
  }

  /**
   * Get the inherited value from the scope hierarchy.
   *
   * When an option is not set at the current level, we need to look up the hierarchy to find what value it inherits. This method traverses the scopes to find
   * the inherited value, checking controller level then global level for device-specific options.
   *
   * @param {string} optionId - The option identifier.
   * @param {Device|undefined} currentDevice - The current device context.
   * @returns {*} The inherited value, or null if none exists.
   * @private
   */
  #getInheritedValue(optionId, currentDevice) {

    if(!currentDevice?.serialNumber && !this.#controller) {

      return null;
    }

    if(currentDevice?.serialNumber !== this.#controller) {

      // Device level - check controller then global. We traverse up the hierarchy looking for the first defined value.
      return this.#featureOptions.value(optionId, this.#controller) ?? this.#featureOptions.value(optionId);
    }

    // Controller level - check global. Controllers inherit from global scope.
    return this.#featureOptions.value(optionId);
  }

  /**
   * Check if configuration should be updated based on current state.
   *
   * We only store configuration entries for options that differ from their defaults or have upstream settings. This keeps the configuration clean and makes it
   * clear what has been customized. Indeterminate states don't need configuration entries since they inherit.
   *
   * @param {HTMLInputElement} checkbox - The checkbox element.
   * @param {Option} option - The option configuration.
   * @param {HTMLInputElement|null} inputValue - The value input element.
   * @param {boolean} upstreamOption - Whether the option is set upstream.
   * @returns {boolean} True if the configuration needs updating.
   * @private
   */
  #shouldUpdateConfiguration(checkbox, option, inputValue, upstreamOption) {

    if(checkbox.indeterminate) {

      return false;
    }

    const isModified = checkbox.checked !== option.default;
    const hasValueChange = inputValue && (inputValue.value.toString() !== option.defaultValue.toString());

    return isModified || hasValueChange || upstreamOption;
  }

  /**
   * Update the option configuration with the current state.
   *
   * This adds the appropriate configuration entry for the option. The format depends on whether it's a simple boolean option or a value-centric option with a
   * custom value. The entry uses Enable/Disable prefixes and includes the device serial number for proper scoping.
   *
   * @param {HTMLInputElement} checkbox - The checkbox element.
   * @param {string[]} newOptions - The new options array to update.
   * @param {HTMLInputElement|null} inputValue - The value input element.
   * @param {string} featureOption - The expanded option name.
   * @private
   */
  #updateOptionConfiguration(checkbox, newOptions, inputValue, featureOption) {

    const prefix = checkbox.checked ? "Enable." : "Disable.";
    const valueSuffix = (this.#featureOptions.isValue(featureOption) && checkbox.checked && inputValue) ? ("." + inputValue.value) : "";

    newOptions.push(prefix + checkbox.value + valueSuffix);
  }

  /**
   * Update the plugin configuration in Homebridge.
   *
   * This updates Homebridge with our configuration changes for the plugin. The changes are staged but not saved until the user explicitly saves the
   * configuration through the Homebridge UI.
   *
   * @param {string[]} newOptions - The updated options array.
   * @returns {Promise<void>}
   * @private
   */
  #updatePluginConfiguration(newOptions) {

    this.currentConfig[0].options = newOptions;
    this.#featureOptions.configuredOptions = newOptions;

    return homebridge.updatePluginConfig(this.currentConfig);
  }

  /**
   * Update the visual state of an option based on its configuration.
   *
   * Options that differ from their defaults are highlighted with text-info to make it clear what has been customized. When an option returns to its default
   * state, we restore the scope-based coloring. This provides immediate visual feedback about option states.
   *
   * @param {HTMLInputElement} checkbox - The checkbox element.
   * @param {Option} option - The option configuration.
   * @param {HTMLLabelElement} label - The option label.
   * @param {string} featureOption - The expanded option name.
   * @param {Device|undefined} currentDevice - The current device context.
   * @private
   */
  #updateOptionVisualState(checkbox, option, label, featureOption, currentDevice) {

    // Clear out any existing hierarchy visual indicators.
    label.classList.remove("text-body", "text-info", "text-success", "text-warning");

    // We aren't inheriting a non-default state, and we've changed the default setting for this option in this context.
    if(!checkbox.indeterminate && (checkbox.checked !== option.default)) {

      label.classList.add("text-info");

      return;
    }

    // Restore scope coloring if we're back to the default. This shows where the option's value is coming from in the hierarchy. We are set to the default in
    // this context or we've inherited a non-default state.
    if((checkbox.checked === option.default) || checkbox.indeterminate) {

      const scopeColor = this.#featureOptions.color(featureOption, currentDevice?.serialNumber, this.#controller);

      // If our option is set to a non-default value, we provide the visual hinting to users so they understand where in the hierarchy it's been set.
      if(scopeColor) {

        label.classList.add(scopeColor);

        return;
      }
    }

    label.classList.add("text-body");
  }

  /**
   * Update visibility of dependent options based on parent state.
   *
   * Grouped options depend on their parent option being enabled. When a parent option changes state, we need to show or hide its dependent options accordingly.
   * During search, we defer to the search handler to manage visibility to avoid conflicts.
   *
   * @param {HTMLInputElement} checkbox - The parent checkbox.
   * @param {string} featureOption - The parent option name.
   * @param {Device|undefined} currentDevice - The current device context.
   * @private
   */
  #updateDependentOptions(checkbox, featureOption, currentDevice) {

    if(!this.#featureOptions.groups[checkbox.id]) {

      return;
    }

    const isEnabled = this.#featureOptions.test(featureOption, currentDevice?.serialNumber, this.#controller);
    const searchInput = document.getElementById("searchInput");
    const isSearching = searchInput?.value.trim().length > 0;

    // Find the table that contains this checkbox to scope our search
    const currentTable = checkbox.closest("table");

    if(!currentTable) {

      return;
    }

    for(const entry of this.#featureOptions.groups[checkbox.id]) {

      // Search for the dependent row within the same table context.
      const row = currentTable.querySelector("[id='row-" + entry + "']");

      if(!row) {

        continue;
      }

      // When searching, let the search handler manage visibility. We trigger a new search to update the results based on the changed state.
      if(isSearching) {

        searchInput.dispatchEvent(new Event("input", { bubbles: true }));

        continue;
      }

      // Update our visibility.
      row.style.display = isEnabled ? "" : "none";
    }

    // Update our status bar.
    this.#updateCounts([...document.querySelectorAll("#configTable tr[id^='row-']")]);
  }

  /**
   * Set up search functionality with debouncing and state management.
   *
   * The search feature allows users to quickly find specific options by typing partial matches. It includes debouncing for performance and supports various
   * keyboard shortcuts for efficiency. The actual logic for search handling and keyboard shortcuts is done through event delegation in
   * #initializeEventDelegation.
   *
   * @private
   */
  #setupSearchFunctionality() {

    const searchInput = document.getElementById("searchInput");

    if(!searchInput) {

      return;
    }

    // Get all searchable elements. We cache these references for performance since they don't change during the lifetime of the view.
    const allRows = [...document.querySelectorAll("#configTable tr[id^='row-']")];

    // Store original visibility states. This allows us to restore the original view when search is cleared.
    const originalVisibility = new Map();

    for(const row of allRows) {

      originalVisibility.set(row, row.style.display);
    }

    // Store references on the search input for use by the delegated event handler.
    searchInput._originalVisibility = originalVisibility;

    // Calculate and display initial counts. This gives users immediate feedback about how many options are available.
    this.#updateCounts(allRows);
  }

  /**
   * Update all count displays in the status bar.
   *
   * This updates both the search results counter and the status bar with current counts. It provides users with immediate feedback about how their actions
   * affect the visible options, including total, modified, grouped, and visible counts.
   *
   * @param {HTMLElement[]} allRows - All option rows.
   * @private
   */
  #updateCounts(allRows) {

    const counts = this.#calculateOptionCounts(allRows);

    this.#updateStatusBar(counts.total, counts.modified, counts.grouped, counts.visible);
  }

  /**
   * Handle search input changes with filtering and category management.
   *
   * This is called after the debounce timeout when the user has stopped typing. It applies both the search term and any active filters to determine which
   * options should be visible. Categories with no visible options are hidden, and those with matches are auto-expanded.
   *
   * @param {string} searchTerm - The current search term.
   * @param {HTMLElement[]} allRows - All option rows.
   * @param {HTMLElement[]} allTables - All category tables.
   * @param {Map<HTMLElement, string>} originalVisibility - Original visibility states.
   * @private
   */
  #handleSearch(searchTerm, allRows, allTables, originalVisibility) {

    const term = searchTerm.toLowerCase();
    const activeFilter = this.#getActiveFilter();

    // Apply search and filter to each row. We combine both criteria to determine final visibility.
    for(const row of allRows) {

      this.#updateRowVisibility(row, this.#shouldShowRow(row, term, activeFilter, originalVisibility), term, activeFilter, originalVisibility);
    }

    // Update counts and category visibility. Empty categories are hidden and categories with matches are expanded.
    this.#updateCounts(allRows);
    this.#updateCategoryVisibility(allTables, searchTerm);
    document.getElementById("toggleAllCategories")?.updateState?.();
  }

  /**
   * Get the currently active filter from the filter pills.
   *
   * Filters and search work together - the active filter determines the base set of options, and search further refines within that set. The active filter is
   * identified by not having the btn-outline-secondary class.
   *
   * @returns {string} The active filter type.
   * @private
   */
  #getActiveFilter() {

    // Return the active filter from the currently selected pill, or "all" if none is selected.
    return (document.querySelector(".filter-pills button:not(.btn-outline-secondary)")?.dataset.filter) ?? "all";
  }

  /**
   * Check if a row should be shown based on search and filter criteria.
   *
   * A row must match both the search term and the active filter to be shown. When neither search nor filter is active, we restore original visibility. This
   * allows proper handling of grouped options that are conditionally visible.
   *
   * @param {HTMLElement} row - The option row.
   * @param {string} searchTerm - The current search term.
   * @param {string} filter - The active filter.
   * @param {Map<HTMLElement, string>} originalVisibility - Original visibility states.
   * @returns {boolean} True if the row should be visible.
   * @private
   */
  #shouldShowRow(row, searchTerm, filter, originalVisibility) {

    if(!searchTerm && (filter === "all")) {

      return originalVisibility.get(row) !== "none";
    }

    const matchesSearch = !searchTerm || row.querySelector("label")?.textContent.toLowerCase().includes(searchTerm);
    const matchesFilter = this.#rowMatchesFilter(row, filter);

    return matchesSearch && matchesFilter;
  }

  /**
   * Update row visibility based on search/filter results with dependency handling.
   *
   * This handles the visual updates when search or filter changes. It includes special handling for grouped options that need dependency indicators when their
   * parent is disabled. Grouped options show visual hints about their dependencies during search.
   *
   * @param {HTMLElement} row - The option row.
   * @param {boolean} shouldShow - Whether the row should be visible.
   * @param {string} searchTerm - The current search term.
   * @param {string} filter - The active filter.
   * @param {Map<HTMLElement, string>} originalVisibility - Original visibility states.
   * @private
   */
  #updateRowVisibility(row, shouldShow, searchTerm, filter, originalVisibility) {

    if(!searchTerm && (filter === "all")) {

      // Restore original state. This includes clearing any temporary modifications made during search.
      row.style.display = originalVisibility.get(row);
      row.style.opacity = "";
      this.#resetRowState(row);
    } else if(shouldShow) {

      row.style.display = "";

      if(row.classList.contains("grouped-option")) {

        // Grouped options need special handling to show when they're disabled due to their parent being off.
        const label = row.querySelector("label");

        this.#handleGroupedOption(row, label);
      } else {

        row.style.opacity = "";
        this.#resetRowState(row);
      }
    } else {

      row.style.display = "none";
    }
  }

  /**
   * Reset row state after search/filter changes.
   *
   * When search is cleared or filters change, we need to remove any temporary modifications made to show dependency states or disable checkboxes. This ensures
   * the UI returns to its normal interactive state.
   *
   * @param {HTMLElement} row - The option row to reset.
   * @private
   */
  #resetRowState(row) {

    const checkbox = row.querySelector("input[type='checkbox']");

    if(checkbox?.dataset.searchDisabled) {

      checkbox.disabled = false;
      delete checkbox.dataset.searchDisabled;
      checkbox.title = "";
    }

    const indicator = row.querySelector(".dependency-indicator");

    if(indicator) {

      indicator.remove();
    }
  }

  /**
   * Default device information panel handler that displays device metadata.
   *
   * This shows device information in the stats panel using a responsive grid layout. Plugins can override this to show additional device-specific information.
   * The grid automatically hides less important fields on smaller screens.
   *
   * @param {Device|undefined} device - The device to show information for.
   * @private
   */
  #showDeviceInfoPanel(device) {

    if(!device) {

      this.#deviceStatsContainer.textContent = "";

      return;
    }

    // Create a grid layout for device stats. This provides better responsiveness than the previous table layout.
    this.#deviceStatsContainer.innerHTML =
      "<div class=\"device-stats-grid\">" +
        "<div class=\"stat-item\">" +
          "<span class=\"stat-label\">Firmware</span>" +
          "<span class=\"stat-value\">" + (device.firmwareRevision ?? "N/A") + "</span>" +
        "</div>" +
        "<div class=\"stat-item\">" +
          "<span class=\"stat-label\">Serial Number</span>" +
          "<span class=\"stat-value\">" + (device.serialNumber ?? "N/A") + "</span>" +
        "</div>" +
        "<div class=\"stat-item\">" +
          "<span class=\"stat-label\">Model</span>" +
          "<span class=\"stat-value\">" + (device.model ?? "N/A") + "</span>" +
        "</div>" +
        "<div class=\"stat-item\">" +
          "<span class=\"stat-label\">Manufacturer</span>" +
          "<span class=\"stat-value\">" + (device.manufacturer ?? "N/A") + "</span>" +
        "</div>" +
      "</div>";
  }

  /**
   * Default method for enumerating the device list in the sidebar with optional grouping.
   *
   * This creates the device entries in the sidebar navigation. Each device gets a clickable entry that shows its feature options when selected. Devices can be
   * organized into groups using the sidebarGroup property, with "hidden" being a reserved group name for devices that shouldn't appear.
   *
   * @private
   */
  #showSidebarDevices() {

    // If we have no devices, there's nothing to display.
    if(!this.#devices?.length) {

      return;
    }

    // Helper function to create and append a device link.
    const appendDeviceLink = (device) => {

      const link = this.#createElement("a", {

        classList: [ "nav-link", "text-decoration-none" ],
        "data-navigation": "device",
        href: "#",
        name: device.serialNumber,
        role: "button"
      }, [device.name ?? "Unknown"]);

      this.#devicesContainer.appendChild(link);
    };

    // Create a group header element and append it to the container.
    const appendGroupHeader = (label) => {

      const header = this.#createElement("h6", {

        classList: [ "nav-header", "text-muted", "text-uppercase", "small", "mb-1" ]
      }, [label]);

      this.#devicesContainer.appendChild(header);
    };

    // Create the top-level device label, if configured, to visually group all devices.
    if(this.#sidebar.deviceLabel) {

      appendGroupHeader(this.#sidebar.deviceLabel);
    }

    // Display ungrouped devices first, by convention.
    for(const device of this.#devices) {

      if(!device.sidebarGroup) {

        appendDeviceLink(device);
      }
    }

    // Determine all valid sidebar groups, excluding controllers and the reserved "hidden" group.
    const groups = [...new Set(
      this.#devices
        .filter(device => !this.#ui.isController(device) && device.sidebarGroup && (device.sidebarGroup !== "hidden"))
        .map(device => device.sidebarGroup)
    )].sort();

    // Display devices by group with headers.
    for(const group of groups) {

      appendGroupHeader(group);

      for(const device of this.#devices) {

        if(device.sidebarGroup === group) {

          appendDeviceLink(device);
        }
      }
    }
  }

  /**
   * Default method for retrieving the device list from the Homebridge accessory cache.
   *
   * This reads devices from Homebridge's cached accessories, extracting the relevant information for display. Plugins can override this to provide devices from
   * other sources like network controllers. The method returns a sorted list of devices with their metadata.
   *
   * @returns {Promise<Device[]>} The list of devices sorted alphabetically by name.
   * @public
   */
  async getHomebridgeDevices() {

    // Retrieve and map the cached accessories to our device format. We extract the specific characteristics we need from the AccessoryInformation service.
    const cachedAccessories = await homebridge.getCachedAccessories();
    const devices = [];

    for(const device of cachedAccessories) {

      const info = device.services.find(s => s.constructorName === "AccessoryInformation");
      const getCharValue = (name) => info?.characteristics.find(c => c.constructorName === name)?.value ?? "";

      devices.push({

        firmwareRevision: getCharValue("FirmwareRevision"),
        manufacturer: getCharValue("Manufacturer"),
        model: getCharValue("Model"),
        name: device.displayName,
        serialNumber: getCharValue("SerialNumber")
      });
    }

    // Sort devices alphabetically by name. This provides a consistent, user-friendly ordering in the sidebar.
    return devices.sort((a, b) => (a.name ?? "").toLowerCase().localeCompare((b.name ?? "").toLowerCase()));
  }

  /**
   * Apply a filter to show only options matching the specified criteria.
   *
   * Filters provide quick ways to focus on specific subsets of options. This is particularly useful for reviewing what has been modified or finding specific
   * types of options. The filter works in conjunction with search for refined results.
   *
   * @param {string} filterType - The type of filter to apply (all, modified, or grouped).
   * @public
   */
  #applyFilter(filterType) {

    const allRows = [...document.querySelectorAll("#configTable tr[id^='row-']")];
    const allTables = [...document.querySelectorAll("#configTable table")];

    // Resolve the active device context so we can evaluate parent state via the model rather than the DOM.
    const deviceSerial = this.#getCurrentDeviceSerial();

    // Apply the filter to each row. The filter determines the base visibility before any search is applied.
    for(const row of allRows) {

      // For grouped options, we need to check if their parent is enabled even when showing "all".
      if(row.classList.contains("grouped-option") && (filterType === "all")) {

        const checkbox = row.querySelector("input[type='checkbox']");

        if(checkbox) {

          // Find the parent option that controls this grouped option.
          const parentId = Object.keys(this.#featureOptions.groups).find(key => this.#featureOptions.groups[key].includes(checkbox.id));
          const isParentEnabled = parentId ? this.#featureOptions.test(parentId, deviceSerial, this.#controller) : true;

          // Only show the grouped option if it matches the filter AND its parent is enabled by the model.
          row.style.display = (this.#rowMatchesFilter(row, filterType) && isParentEnabled) ? "" : "none";
        } else {

          row.style.display = this.#rowMatchesFilter(row, filterType) ? "" : "none";
        }

        continue;
      }

      row.style.display = this.#rowMatchesFilter(row, filterType) ? "" : "none";
    }

    // Update counts and visibility. We need to update various UI elements to reflect the filtered view.
    this.#updateCounts(allRows);
    this.#updateCategoryVisibility(allTables, "");
    document.getElementById("toggleAllCategories")?.updateState?.();

    // Reapply search if active. Search works within the filtered set, so we need to rerun it when the filter changes.
    const searchInput = document.getElementById("searchInput");

    if(searchInput?.value) {

      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  /**
   * Check if a row matches the specified filter criteria.
   *
   * Each filter has specific criteria for what rows it includes. This method centralizes the filter logic for consistent behavior. Currently supports "all"
   * and "modified" filters with room for expansion.
   *
   * @param {HTMLElement} row - The table row element to check.
   * @param {string} filterType - The filter type to match against.
   * @returns {boolean} True if the row matches the filter.
   * @public
   */
  #rowMatchesFilter(row, filterType) {

    switch(filterType) {

      case "modified":

        // Modified options have the text-info class to indicate they differ from defaults.
        return row.querySelector("label")?.classList.contains("text-info") ?? false;

      case "all":
      default:

        return true;
    }
  }

  /**
   * Calculate counts for all option states.
   *
   * This provides the statistics shown in the status bar. We count total options, how many are modified, grouped, and currently visible based on
   * filters/search. These counts help users understand the scope of their configuration.
   *
   * @param {NodeList|Array} allRows - All option rows to count.
   * @returns {{total: number, modified: number, grouped: number, visible: number}} Count statistics.
   * @public
   */
  #calculateOptionCounts(allRows) {

    return [...allRows].reduce((counts, row) => {

      counts.total++;

      if(row.style.display !== "none") {

        counts.visible++;
      }

      if(row.querySelector("label")?.classList.contains("text-info")) {

        counts.modified++;
      }

      if(row.classList.contains("grouped-option")) {

        counts.grouped++;
      }

      return counts;
    }, { grouped: 0, modified: 0, total: 0, visible: 0 });
  }

  /**
   * Update the status bar with current option counts and scope indication.
   *
   * The status bar provides at-a-glance information about the current view. It's updated whenever search, filters, or option states change. The scope label
   * indicates whether we're viewing global, controller, or device options.
   *
   * @param {number} total - Total number of options.
   * @param {number} modified - Number of modified options.
   * @param {number} grouped - Number of grouped options.
   * @param {number} visible - Number of currently visible options.
   * @public
   */
  #updateStatusBar(total, modified, grouped, visible) {

    const statusInfo = document.getElementById("statusInfo");

    if(!statusInfo) {

      return;
    }

    // Check for device-level scope before checking for controller and global scope.
    const scope = this.#devicesContainer.querySelector("a[data-navigation='device'].active")?.dataset?.navigation ??
      this.#controllersContainer.querySelector(".nav-link.active[data-navigation]")?.dataset?.navigation ?? "unknown";

    statusInfo.style.whiteSpace = "nowrap";
    statusInfo.innerHTML = "<span class=\"text-muted\"><strong>" + total + " " + scope + " options \u00B7 " +
      "<span class=\"text-info\">" + modified + "</span> modified \u00B7 " + grouped + " grouped \u00B7 " + visible + " visible" + "</strong></span>";
  }

  /**
   * Reset all options to their default values.
   *
   * This provides a quick way to return to a clean configuration. It's a destructive action that clears all customization. After reset, the UI is refreshed to
   * show the clean state with all options at their defaults.
   *
   * @returns {Promise<void>}
   * @public
   */
  async #resetAllOptions() {

    homebridge.showSpinner();

    // Clear all configured options. An empty options array means everything returns to defaults.
    this.currentConfig[0].options = [];
    this.#featureOptions.configuredOptions = [];

    // Update the configuration in Homebridge. This persists the reset.
    await homebridge.updatePluginConfig(this.currentConfig);

    // Find the currently selected device. We want to maintain the user's context after the reset.
    const selectedDevice = this.#devicesContainer.querySelector("a[data-navigation='device'].active");

    // Refresh the UI to show the reset state. All options will now show their default values.
    this.#showDeviceOptions(selectedDevice?.name ?? "Global Options");

    homebridge.hideSpinner();

    // Show a success message. This confirms the action completed successfully.
    this.#showResetSuccessMessage();
  }

  /**
   * Show a success message after resetting to defaults.
   *
   * This provides positive feedback that the reset action completed successfully. The message auto-dismisses after a few seconds to avoid cluttering the UI.
   * Uses Bootstrap's alert component for consistent styling.
   *
   * @private
   */
  #showResetSuccessMessage() {

    const statusBar = document.getElementById("featureStatusBar");

    if(!statusBar) {

      return;
    }

    const successMsg = this.#createElement("div", {

      classList: "alert alert-success alert-dismissible fade show mt-2",
      innerHTML: "<strong>All options have been reset to their default values.</strong>" +
        "<button type=\"button\" class=\"btn-close\" data-bs-dismiss=\"alert\" aria-label=\"Close\"></button>",
      role: "alert"
    });

    statusBar.insertAdjacentElement("afterend", successMsg);

    // Auto-dismiss after 3 seconds. This keeps the UI clean while still providing sufficient time to read the message.
    setTimeout(() => {

      successMsg.classList.remove("show");
      setTimeout(() => successMsg.remove(), 150);
    }, 3000);
  }

  /**
   * Handle the special display requirements for grouped options during search.
   *
   * Grouped options have dependencies on parent options. When searching, we need to show these dependencies clearly even when the parent option might be
   * filtered out. This method handles the visual indicators and state management, adding badges and disabling checkboxes as needed.
   *
   * @param {HTMLElement} row - The table row element.
   * @param {HTMLElement} label - The label element within the row.
   * @returns {{isDependent: boolean, isParentEnabled: boolean}} Dependency state information.
   * @private
   */
  #handleGroupedOption(row, label) {

    const checkbox = row.querySelector("input[type='checkbox']");

    if(!checkbox) {

      return { isDependent: false, isParentEnabled: false };
    }

    // Find the parent that controls this option. We look through the groups mapping to find which parent controls this child option.
    const parentId = Object.keys(this.#featureOptions.groups).find(key => this.#featureOptions.groups[key].includes(checkbox.id));

    // Evaluate the parent state using the model so that inherited/indeterminate states are handled correctly.
    const deviceSerial = this.#getCurrentDeviceSerial();
    const isParentEnabled = parentId ? this.#featureOptions.test(parentId, deviceSerial, this.#controller) : true;

    if(!isParentEnabled) {

      // Parent disabled - show as unavailable. We use visual indicators to make it clear why this option can't be enabled.
      row.style.opacity = "0.5";
      checkbox.disabled = true;
      checkbox.title = "Parent option must be enabled first";
      checkbox.dataset.searchDisabled = "true";

      // Add dependency indicator if needed. This badge makes the dependency clear even when the parent is filtered out.
      if(!label?.querySelector(".dependency-indicator")) {

        const indicator = this.#createElement("span", {

          classList: "dependency-indicator badge bg-warning text-dark ms-2",
          style: { fontSize: "0.75em" },
          textContent: "requires parent"
        });

        label?.appendChild(indicator);
      }

      return { isDependent: true, isParentEnabled: false };
    }

    // Parent enabled - fully available. Remove any dependency indicators since the option can now be toggled freely.
    row.style.opacity = "";

    if(checkbox.dataset.searchDisabled) {

      checkbox.disabled = false;
      delete checkbox.dataset.searchDisabled;
      checkbox.title = "";
    }

    // Remove any dependency indicator.
    label?.querySelector(".dependency-indicator")?.remove();

    return { isDependent: false, isParentEnabled: true };
  }

  /**
   * Update category visibility based on search results.
   *
   * During search, we hide categories that have no matching options and automatically expand categories that do have matches. This helps users quickly see all
   * matching options without manually expanding categories. Empty categories are completely hidden to reduce visual clutter.
   *
   * @param {NodeList|Array} allTables - All category tables.
   * @param {string} searchTerm - The current search term.
   * @public
   */
  #updateCategoryVisibility(allTables, searchTerm) {

    for(const table of [...allTables]) {

      const tbody = table.querySelector("tbody");

      if(!tbody) {

        continue;
      }

      // Check if any rows are visible. A category with no visible options should be hidden entirely.
      const hasVisible = [...tbody.querySelectorAll("tr")].some(row => row.style.display !== "none");

      // Hide empty categories. This keeps the UI clean during filtered views.
      table.style.display = hasVisible ? "" : "none";

      // Auto-expand categories with search matches. This ensures users see all matching options without having to manually expand each category.
      if(searchTerm && hasVisible && (tbody.style.display === "none")) {

        tbody.style.display = "table-row-group";

        const indicator = table.querySelector("thead span");

        if(indicator) {

          indicator.textContent = "\u25BC ";
        }

        // Ensure accessibility state reflects the open state.
        const headerCell = table.querySelector("thead th[role='button']");

        if(headerCell) {

          headerCell.setAttribute("aria-expanded", "true");
        }
      }
    }
  }

  /**
   * Inject custom styles for hover effects, dark mode support, and modern layouts.
   *
   * These styles enhance the visual experience and ensure our UI integrates well with both light and dark modes. We use media queries to automatically adapt
   * to the user's system preferences. The styles include support for flexbox layouts, responsive design, and theme-aware coloring.
   *
   * @private
   */
  #injectCustomStyles() {

    // Ensure we do not inject duplicate styles when re-entering this view. We make this idempotent for stability across navigations.
    if(document.getElementById("feature-options-styles")) {

      return;
    }

    const styles = [

      /* eslint-disable @stylistic/max-len */
      // Define CSS variables used throughout our webUI. We update these when the theme changes so the UI can respond according to the visual environment.
      ":root {",
      "  --plugin-primary-bg: " + this.#themeColor.background + ";",
      "  --plugin-primary-fg: " + this.#themeColor.text + ";",
      "  --plugin-primary-hover: rgba(0,0,0,0.05); /* placeholder, JS will override with a color-specific value */",
      "  --plugin-primary-subtle: rgba(0,0,0,0.03); /* placeholder, JS will override with a color-specific value */",
      "  --plugin-body-bg-light: #ffffff;",
      "  --plugin-body-bg-dark: #242424;",
      "  --plugin-sidebar-bg-light: var(--bs-gray-100);",
      "  --plugin-sidebar-bg-dark: #1A1A1A;",
      "}",

      // We start with a base layout reset - remove margin collapse and enable clean layout flow.
      "html, body { margin: 0; padding: 0; }",

      // Theme-scoped body and sidebar backgrounds. We scope to app-driven theme first.
      ":root[data-plugin-theme='light'] body { background-color: var(--plugin-body-bg-light) !important; }",
      ":root[data-plugin-theme='dark'] body { background-color: var(--plugin-body-bg-dark) !important; }",
      ":root[data-plugin-theme='light'] #sidebar { background-color: var(--plugin-sidebar-bg-light) !important; }",
      ":root[data-plugin-theme='dark'] #sidebar { background-color: var(--plugin-sidebar-bg-dark) !important; }",

      // Page root uses a column layout with full width.
      "#pageFeatureOptions { display: flex !important; flex-direction: column; width: 100%; }",

      // Sidebar + content layout is horizontal (row).
      ".feature-main-content { display: flex !important; flex-direction: row !important; width: 100%; }",

      // Sidebar layout and appearance.
      "#sidebar { display: block; width: 200px; min-width: 200px; max-width: 200px; position: relative; }",

      // Remove internal scrolling from sidebar content.
      "#sidebar .sidebar-content { padding: 0rem; overflow: unset; }",

      // Sidebar containers.
      "#controllersContainer { padding: 0; margin-bottom: 0; }",
      "#devicesContainer { padding: 0; margin-top: 0; padding-top: 0 !important; }",

      // Feature content (right-hand pane).
      ".feature-content { display: flex !important; flex-direction: column !important; flex: 1 1 auto; min-width: 0; }",
      // ".category-border { border: 1px solid " + this.#themeColor.background + " !important; box-shadow: 0 0 0 1px " + rgba(this.#themeColor.background, 0.1) + "; }",
      ".category-border { border: 1px solid var(--plugin-primary-bg) !important; box-shadow: 0 0 0 1px var(--plugin-primary-hover); }",

      // Ensure the table itself uses separate borders when we have rounded tbody elements. This is necessary for border-radius to work properly.
      "table[data-category] { border-collapse: separate !important; border-spacing: 0; }",

      // How we define row visibility for feature options. We need this complexity because we hide or make visible rows depending on what the user has chosen to expose.
      //
      // "table[data-category] tbody tr.fo-visible,"
      // "table[data-category] tbody tr:not([hidden]):not(.d-none):not(.is-hidden):not([style*='display: none']){}",

      // Create the outer border of the table on the left and right sides.
      "table[data-category] tbody tr:not([hidden]):not(.d-none):not(.is-hidden):not([style*='display: none']) td:first-child{",
      "  border-left:1px solid var(--plugin-primary-bg);",
      "}",
      "table[data-category] tbody tr:not([hidden]):not(.d-none):not(.is-hidden):not([style*='display: none']) td:last-child{",
      "  border-right:1px solid var(--plugin-primary-bg);",
      "}",

      // Provide the top border on the first visible row.
      "table[data-category] tbody tr:nth-child(1 of :not([hidden]):not(.d-none):not(.is-hidden):not([style*='display: none'])) td{",
      "  border-top:1px solid var(--plugin-primary-bg);",
      "}",

      // Provide the bottom border on the last visible row.
      "table[data-category] tbody tr:nth-last-child(1 of :not([hidden]):not(.d-none):not(.is-hidden):not([style*='display: none'])) td{",
      "  border-bottom:1px solid var(--plugin-primary-bg);",
      "}",

      // Create rounded corners at the top and bottom rows.
      "table[data-category] tbody tr:nth-child(1 of :not([hidden]):not(.d-none):not(.is-hidden):not([style*='display: none'])) td:first-child{",
      "  border-top-left-radius:.5rem;",
      "}",
      "table[data-category] tbody tr:nth-child(1 of :not([hidden]):not(.d-none):not(.is-hidden):not([style*='display: none'])) td:last-child{",
      "  border-top-right-radius:.5rem;",
      "}",
      "table[data-category] tbody tr:nth-last-child(1 of :not([hidden]):not(.d-none):not(.is-hidden):not([style*='display: none'])) td:first-child{",
      "  border-bottom-left-radius:.5rem;",
      "}",
      "table[data-category] tbody tr:nth-last-child(1 of :not([hidden]):not(.d-none):not(.is-hidden):not([style*='display: none'])) td:last-child{",
      "  border-bottom-right-radius:.5rem;",
      "}",

      // Main options area - remove scroll behavior, just layout styling.
      ".options-content { padding: 1rem; margin: 0; }",

      // Info header styling.
      "#headerInfo { flex-shrink: 0; padding: 0.5rem !important; margin-bottom: 0.5rem !important; }",

      // Device stats grid layout.
      ".device-stats-grid { display: flex; justify-content: space-between; gap: 0.75rem; margin-bottom: 0.5rem; padding: 0 0.75rem; flex-wrap: nowrap; overflow: hidden; }",
      ".device-stats-grid .stat-item:first-child { flex: 0 0 25% }",
      ".device-stats-grid .stat-item:not(:first-child) { flex-grow: 1; min-width: 0; }",

      ".stat-item { display: flex; flex-direction: column; gap: 0.125rem; }",
      ".stat-label { font-weight: 600; color: var(--bs-gray-600); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }",
      ".stat-value { font-size: 0.875rem; color: var(--bs-body-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }",

      // Responsive hiding for our device stats grid.
      "@media (max-width: 700px) { .device-stats-grid .stat-item:nth-last-of-type(1) { display: none !important; } }",
      "@media (max-width: 500px) { .device-stats-grid .stat-item:nth-last-of-type(2) { display: none !important; } }",
      "@media (max-width: 300px) { .device-stats-grid .stat-item:nth-last-of-type(3) { display: none !important; } }",

      // Responsive hiding for feature option status information.
      "@media (max-width: 400px) { #statusInfo { display: none !important; } }",

      // Navigation styles.
      ".nav-link { border-radius: 0.375rem; transition: all 0.2s; position: relative; padding: 0.25rem 0.75rem !important; line-height: 1.2; font-size: 0.8125rem; }",
      ".nav-link:hover { background-color: var(--plugin-primary-hover); color: var(--plugin-primary-bg) !important; }",
      ".nav-link.active { background-color: var(--plugin-primary-bg); color: var(--plugin-primary-fg) !important; }",
      ".nav-header { border-bottom: 1px solid rgba(0, 0, 0, 0.1); margin-bottom: 0.125rem; padding: 0.25rem 0.75rem !important; font-size: 0.75rem !important; line-height: 1.2; }",
      "#devicesContainer .nav-header { font-weight: 600; margin-top: 0 !important; padding-top: 0.5rem !important; }",
      "#controllersContainer .nav-header { font-weight: 600; margin-top: 0 !important; padding-top: 0.5rem !important; }",

      // Search bar.
      ".search-toolbar { border-radius: 0.5rem; padding: 0 0 0.5rem 0; }",
      ".search-input-wrapper { min-width: 0; }",
      ".filter-pills { display: flex; gap: 0.5rem; flex-wrap: wrap; }",

      // Grouped option visual indicator.
      ".grouped-option { background-color: var(--plugin-primary-subtle); }",
      ".grouped-option td:nth-child(2) label { padding-left: 20px; position: relative; }",
      ".grouped-option td:nth-child(2) label::before { content: \"\\21B3\"; position: absolute; left: 4px; color: #666; }",

      // Dark-mode refinements.
      ":root[data-plugin-theme='dark'] .nav-header { border-bottom-color: rgba(255, 255, 255, 0.1); }",
      ":root[data-plugin-theme='dark'] .text-body { color: #999 !important; }",
      ":root[data-plugin-theme='dark'] .text-muted { color: #999 !important; }",
      ":root[data-plugin-theme='dark'] .device-stats-grid { background-color: #1A1A1A; border-color: #444; }",
      ":root[data-plugin-theme='dark'] .stat-label { color: #999; }",
      ":root[data-plugin-theme='dark'] .stat-value { color: #999; }",
      ":root[data-plugin-theme='dark'] #search .form-control { background-color: #1A1A1A; border-color: #444; color: #F8F9FA; }",
      ":root[data-plugin-theme='dark'] #search .form-control:focus { background-color: #1A1A1A; border-color: #666; color: #F8F9FA; box-shadow: 0 0 0 0.2rem rgba(255, 160, 0, 0.25); }",
      ":root[data-plugin-theme='dark'] #search .form-control::placeholder { color: #999; }",
      ":root[data-plugin-theme='dark'] #statusInfo .text-muted { color: #B8B8B8 !important; }",

      // Table hover styling.
      ".table-hover tbody tr { transition: background-color 0.15s; }",
      ":root[data-plugin-theme='light'] .table-hover tbody tr:hover { background-color: rgba(0, 0, 0, 0.03); }",
      ":root[data-plugin-theme='dark'] .table-hover tbody tr:hover { background-color: rgba(255, 255, 255, 0.20); }",


      // Utility styles.
      ".btn-xs { font-size: 0.75rem !important; padding: 0.125rem 0.5rem !important; line-height: 1.5; touch-action: manipulation; }",
      ".cursor-pointer { cursor: pointer; }",
      ".user-select-none { user-select: none; -webkit-user-select: none; }",

      // Use CSS for the category header hover emphasis to avoid JS event handlers for simple hover effects.
      "table[data-category] thead th[role='button']:hover { color: var(--plugin-primary-bg) !important; }",

      // Respect reduced motion settings for accessibility.
      "@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }"
      /* eslint-enable @stylistic/max-len */
    ];

    const styleElement = this.#createElement("style", { id: "feature-options-styles" }, [styles.join("\n")]);

    document.head.appendChild(styleElement);
  }

  /**
   * Set up automatic theme detection and live updates.
   *
   * We rely on Config UI X to tell us what the preferred color scheme is. Once we have it, we recompute our color variables derived from .btn-primary whenever the theme
   * changes before mirroring all that to :root[data-plugin-theme="light|dark"] so our injected CSS is instantly reflected in our webUI.
   *
   * @private
   */
  async #setupThemeAutoUpdate() {

    // Apply the current theme lighting mode and compute color variables.
    this.#setPluginTheme(await homebridge.userCurrentLightingMode());

    // Finally, we listen for system and browser changes to the current dark mode setting.
    this.#addEventListener(window.matchMedia("(prefers-color-scheme: dark)"), "change", async () => this.#setPluginTheme(await homebridge.userCurrentLightingMode()));
  }

  /**
   * Apply the current theme to :root and recompute JS-derived CSS variables.
   *
   * @param {"light"|"dark"} mode
   * @private
   */
  #setPluginTheme(mode) {

    // Sanity check.
    if(![ "dark", "light" ].includes(mode)) {

      return;
    }

    // See if we're already set appropriately. If so, we're done.
    const current = document.documentElement.getAttribute("data-plugin-theme");

    if(current === mode) {

      return;
    }

    // Update our theme.
    document.documentElement.setAttribute("data-plugin-theme", mode);

    this.#computeThemeColors();
    this.#updateCssVariablesFromTheme();
  }

  /**
   * Compute current primary background and foreground from Bootstrap's .btn-primary.
   *
   * This gives us a theme-correct color pair regardless of the configured palette in Config UI X.
   *
   * @private
   */
  #computeThemeColors() {

    const probeBtn = document.createElement("button");

    probeBtn.className = "btn btn-primary";
    probeBtn.style.display = "none";
    document.body.appendChild(probeBtn);

    this.#themeColor.background = getComputedStyle(probeBtn).backgroundColor;
    this.#themeColor.text = getComputedStyle(probeBtn).color;

    document.body.removeChild(probeBtn);
  }

  /**
   * Update CSS custom properties used by our injected styles so they immediately reflect the current theme.
   *
   * @private
   */
  #updateCssVariablesFromTheme() {

    const rootStyle = document.documentElement.style;

    const rgba = (rgb, alpha) => {

      const match = rgb.match(/\d+/g);

      if(!match || (match.length < 3)) {

        return rgb;
      }

      return "rgba(" + match[0] + ", " + match[1] + ", " + match[2] + ", " + alpha + ")";
    };


    // These variables are consumed by our injected CSS.
    rootStyle.setProperty("--plugin-primary-bg", this.#themeColor.background);
    rootStyle.setProperty("--plugin-primary-fg", this.#themeColor.text);

    // Derivatives used for hover/subtle surfaces.
    rootStyle.setProperty("--plugin-primary-hover", rgba(this.#themeColor.background, 0.10));
    rootStyle.setProperty("--plugin-primary-subtle", rgba(this.#themeColor.background, 0.08));
  }

  /**
   * Clean up all resources when the instance is no longer needed.
   *
   * This should be called before creating a new instance or when navigating away from the feature options view. It ensures all event listeners are removed and
   * resources are freed to prevent memory leaks. The search input is also cleared to reset any pending timeouts.
   *
   * @public
   */
  cleanup() {

    this.#cleanupEventListeners();
    this.#eventListeners.clear();

    // Clear any pending timeouts from search debouncing. This prevents the timeout from firing after the instance is destroyed.
    const searchInput = document.getElementById("searchInput");

    if(searchInput) {

      if(searchInput._searchTimeout) {

        clearTimeout(searchInput._searchTimeout);
        searchInput._searchTimeout = null;
      }

      searchInput.value = "";
    }
  }

  /**
   * Get the currently selected device serial number from the UI.
   *
   * This helper centralizes how we determine the active device context, which is useful for model-based checks during search and filtering.
   *
   * @returns {string|null} The active device serial or null for global context.
   * @private
   */
  #getCurrentDeviceSerial() {

    const activeDeviceLink = this.#devicesContainer.querySelector("a[data-navigation='device'].active");

    return activeDeviceLink?.name ?? null;
  }

  /**
   * Compare two arrays of strings for set-wise equality.
   *
   * This allows us to decide whether the saved snapshot should be updated when loaded plugin config changes order or content.
   *
   * @param {string[]} a - First array.
   * @param {string[]} b - Second array.
   * @returns {boolean} True if both arrays contain the same strings (order-insensitive).
   * @private
   */
  #sameStringArray(a, b) {

    if(a === b) {

      return true;
    }

    if(!Array.isArray(a) || !Array.isArray(b)) {

      return false;
    }

    if(a.length !== b.length) {

      return false;
    }

    // We compare order-insensitively by sorting shallow copies.
    const aa = [...a].sort();
    const bb = [...b].sort();

    for(let i = 0; i < aa.length; i++) {

      if(aa[i] !== bb[i]) {

        return false;
      }
    }

    return true;
  }
}
