/* Copyright(C) 2017-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi.mjs: Plugin webUI.
 */
"use strict";

export class webUi {

  // Feature options class instance.
  #featureOptions;

  // First run webUI callback endpoints for customization.
  #firstRunInit;
  #firstRunRequired;
  #firstRunSubmit;

  // Homebridge class instance.
  #homebridge;

  // Plugin name.
  #name;

  constructor({ name, featureOptions, firstRunInit = true, firstRunRequired = false, firstRunSubmit = true, homebridge } = {}) {

    this.homebridge = homebridge;
    this.featureOptions = featureOptions;
    this.firstRunInit = firstRunInit;
    this.firstRunRequired = firstRunRequired;
    this.firstRunSubmit = firstRunSubmit;
    this.name = name;

    // Fire off our UI, catching errors along the way.
    try {

      this.#launchWebUI();
    } catch(err) {

      // If we had an error instantiating or updating the UI, notify the user.
      this.homebridge.toast.error(err.message, "Error");
    } finally {

      // Always leave the UI in a usable place for the end user.
      this.homebridge.hideSpinner();
    }
  }

  // Show the first run user experience if we don't have valid login credentials.
  async #showFirstRun() {

    const buttonFirstRun = document.getElementById("firstRun");

    // Run a custom initialization handler the user may have provided.
    if(!(await this.#processHandler(this.firstRunInit))) {

      return;
    }

    // First run user experience.
    buttonFirstRun.addEventListener("click", async () => {

      // Show the beachball while we setup.
      this.homebridge.showSpinner();

      // Run a custom submit handler the user may have provided.
      if(!(await this.#processHandler(this.firstRunSubmit))) {

        return;
      }

      // Create our UI.
      document.getElementById("pageFirstRun").style.display = "none";
      document.getElementById("menuWrapper").style.display = "inline-flex";
      this.featureOptions.showUI();

      // All done. Let the user interact with us, although in practice, we shouldn't get here.
      // this.homebridge.hideSpinner();
    });

    document.getElementById("pageFirstRun").style.display = "block";
  }

  // Show the main plugin configuration tab.
  #showSettings() {

    // Show the beachball while we setup.
    this.homebridge.showSpinner();

    // Highlight the tab in our UI.
    this.#toggleClasses("menuHome", "btn-elegant", "btn-primary");
    this.#toggleClasses("menuFeatureOptions", "btn-elegant", "btn-primary");
    this.#toggleClasses("menuSettings", "btn-primary", "btn-elegant");

    document.getElementById("pageSupport").style.display = "none";
    document.getElementById("pageFeatureOptions").style.display = "none";

    this.homebridge.showSchemaForm();

    // All done. Let the user interact with us.
    this.homebridge.hideSpinner();
  }

  // Show the support tab.
  #showSupport() {

    // Show the beachball while we setup.
    this.homebridge.showSpinner();
    this.homebridge.hideSchemaForm();

    // Highlight the tab in our UI.
    this.#toggleClasses("menuHome", "btn-primary", "btn-elegant");
    this.#toggleClasses("menuFeatureOptions", "btn-elegant", "btn-primary");
    this.#toggleClasses("menuSettings", "btn-elegant", "btn-primary");

    document.getElementById("pageSupport").style.display = "block";
    document.getElementById("pageFeatureOptions").style.display = "none";

    // All done. Let the user interact with us.
    this.homebridge.hideSpinner();
  }

  // Launch our webUI.
  async #launchWebUI() {

    // Retrieve the current plugin configuration.
    this.featureOptions.currentConfig = await this.homebridge.getPluginConfig();

    // Add our event listeners to animate the UI.
    document.getElementById("menuHome").addEventListener("click", () => this.#showSupport());
    document.getElementById("menuFeatureOptions").addEventListener("click", () => this.featureOptions.showUI());
    document.getElementById("menuSettings").addEventListener("click", () => this.#showSettings());

    // Get the list of devices the plugin knows about.
    const devices = await this.homebridge.getCachedAccessories();

    // If we've got devices detected, we launch our feature option UI. Otherwise, we launch our first run UI.
    if(this.featureOptions.currentConfig.length && devices?.length && !(await this.#processHandler(this.firstRunRequired))) {

      document.getElementById("menuWrapper").style.display = "inline-flex";
      this.featureOptions.showUI();

      return;
    }

    // If we have the name property set for the plugin configuration yet, let's do so now. If we don't have a configuration, let's initialize it as well.
    (this.featureOptions.currentConfig[0] ??= { name: this.name }).name ??= this.name;

    // Update the plugin configuration and launch the first run UI.
    await this.homebridge.updatePluginConfig(this.featureOptions.currentConfig);
    this.#showFirstRun();
  }

  // Utility to process user-provided custom handlers that can handle both synchronous and asynchronous handlers.
  async #processHandler(handler) {

    if(((typeof handler === "function") && !(await handler())) || ((typeof handler !== "function") && !handler)) {

      return false;
    }

    return true;
  }

  // Utility to toggle our classes.
  #toggleClasses(id, removeClass, addClass) {

    const element = document.getElementById(id);
    element.classList.remove(removeClass);
    element.classList.add(addClass);
  }
}
