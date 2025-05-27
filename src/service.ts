/* Copyright(C) 2017-2025, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * service.ts: Useful Homebridge service support functions.
 */

/**
 * Homebridge service helper utilities.
 *
 * @module
 */
import type { HAP, PlatformAccessory, Service, WithUUID } from "homebridge";
import { type Nullable, validateName } from "./util.js";

/**
 * Utility method that either creates a new service on an accessory if needed, or returns an existing one. Optionally, it executes a callback to initialize a new
 * service instance. Additionally, the various name characteristics of the service are set to the specified name, and optionally added if necessary.
 *
 * @param hap             - HAP instance associated with the Homebridge plugin.
 * @param accessory       - The Homebridge accessory to check or modify.
 * @param serviceType     - The type of service to instantiate or retrieve.
 * @param name            - Name to be displayed to the end user for this service.
 * @param subtype         - Optional service subtype to uniquely identify the service.
 * @param onServiceCreate - Optional callback invoked only when a new service is created, receiving the new service as its argument.
 *
 * @returns Returns the created or retrieved service, or `null` if service creation failed.
 *
 * @remarks
 * This method ensures that the service's display name and available name characteristics are updated to the specified name. If `onServiceCreate` is provided,
 * it will only be called for newly created services, not for existing ones.
 *
 * The `ConfiguredName` and `Name` characteristics are conditionally added or updated based on the type of service, in accordance with HomeKit requirements.
 *
 * @example
 * ```typescript
 * // Example: Ensure a Lightbulb service exists with a user-friendly name, and initialize it if newly created.
 * const lightbulbService = acquireService(hap, accessory, hap.Service.Lightbulb, "Living Room Lamp", undefined, (svc: Service): void => {
 *
 *   // Called only if the service is newly created.
 *   svc.setCharacteristic(hap.Characteristic.On, false);
 * });
 *
 * if(lightbulbService) {
 *
 *   // Service is now available, with display name set and optional characteristics managed.
 *   lightbulbService.updateCharacteristic(hap.Characteristic.Brightness, 75);
 * }
 * ```
 *
 * @category Accessory
 */
export function acquireService(hap: HAP, accessory: PlatformAccessory, serviceType: WithUUID<typeof Service>, name: string, subtype?: string,
  onServiceCreate?: (svc: Service) => void): Nullable<Service> {

  // Services that do not need the Name characteristic added as an optional characteristic.
  const configuredNameRequiredServices = [ hap.Service.InputSource, hap.Service.Television, hap.Service.WiFiRouter ];

  // Services that need the ConfiguredName characteristic added and maintained.
  const configuredNameServices = [ hap.Service.AccessoryInformation, hap.Service.ContactSensor, hap.Service.Lightbulb, hap.Service.MotionSensor,
    hap.Service.OccupancySensor, hap.Service.SmartSpeaker, hap.Service.Switch, hap.Service.Valve ];

  // Services that do not need the Name characteristic added as an optional characteristic.
  const nameRequiredServices = [ hap.Service.AccessoryInformation, hap.Service.Assistant, hap.Service.InputSource ];

  // Services that need the Name characteristic maintained.
  const nameServices = [ hap.Service.AirPurifier, hap.Service.AirQualitySensor, hap.Service.Battery, hap.Service.CarbonDioxideSensor,
    hap.Service.CarbonMonoxideSensor, hap.Service.ContactSensor, hap.Service.Door, hap.Service.Doorbell, hap.Service.Fan, hap.Service.Fanv2, hap.Service.Faucet,
    hap.Service.FilterMaintenance, hap.Service.GarageDoorOpener, hap.Service.HeaterCooler, hap.Service.HumidifierDehumidifier, hap.Service.HumiditySensor,
    hap.Service.IrrigationSystem, hap.Service.LeakSensor, hap.Service.Lightbulb, hap.Service.LightSensor, hap.Service.LockMechanism, hap.Service.MotionSensor,
    hap.Service.OccupancySensor, hap.Service.Outlet, hap.Service.SecuritySystem, hap.Service.Slats, hap.Service.SmartSpeaker, hap.Service.SmokeSensor,
    hap.Service.StatefulProgrammableSwitch, hap.Service.StatelessProgrammableSwitch, hap.Service.Switch, hap.Service.TargetControl, hap.Service.Television,
    hap.Service.TemperatureSensor, hap.Service.Thermostat, hap.Service.Valve, hap.Service.Window, hap.Service.WindowCovering ];

  // Ensure we have HomeKit approved naming.
  name = validateName(name);

  // Find the service, if it exists.
  let service = subtype ? accessory.getServiceById(serviceType, subtype) : accessory.getService(serviceType);

  // Add the service to the accessory, if needed.
  if(!service) {

    service = new serviceType(name, subtype as string);

    if(!service) {

      return null;
    }

    // Add the Configured Name characteristic if we don't already have it and it's available to us.
    if(!configuredNameRequiredServices.includes(serviceType) && configuredNameServices.includes(serviceType) &&
      !service.optionalCharacteristics.some(x => (x.UUID === hap.Characteristic.ConfiguredName.UUID))) {

      service.addOptionalCharacteristic(hap.Characteristic.ConfiguredName);
    }

    // Add the Name characteristic if we don't already have it and it's available to us.
    if(!nameRequiredServices.includes(serviceType) && nameServices.includes(serviceType) &&
      !service.optionalCharacteristics.some(x => (x.UUID === hap.Characteristic.Name.UUID))) {

      service.addOptionalCharacteristic(hap.Characteristic.Name);
    }

    accessory.addService(service);

    if(onServiceCreate) {

      onServiceCreate(service);
    }
  }

  // Update our name.
  service.displayName = name;

  if(configuredNameServices.includes(serviceType)) {

    service.updateCharacteristic(hap.Characteristic.ConfiguredName, name);
  }

  if(nameServices.includes(serviceType)) {

    service.updateCharacteristic(hap.Characteristic.Name, name);
  }

  return service;
}

/**
 * Validates whether a specific service should exist on the given accessory, removing the service if it fails validation.
 *
 * @param accessory   - The Homebridge accessory to inspect and potentially modify.
 * @param serviceType - The type of Homebridge service being checked or instantiated.
 * @param validate    - A boolean or a function that determines if the service should exist. If a function is provided, it receives a boolean indicating whether the
 *                      service currently exists, and should return `true` to keep the service, or `false` to remove it.
 * @param subtype     - Optional service subtype to uniquely identify the service.
 *
 * @returns `true` if the service is valid (and kept), or `false` if it was removed.
 *
 * @remarks
 * The `validate` parameter can be either:
 *   - a boolean (where `true` means keep the service, `false` means remove it).
 *   - a function (which is called with `hasService: boolean` and returns whether to keep the service).
 *
 * If the service should not exist according to `validate`, and it is currently present, this function will remove it from the accessory.
 *
 * @example
 * ```typescript
 * // Remove a service if it exists
 * validService(accessory, Service.Switch, false);
 *
 * // Only keep a service if a configuration flag is true
 * validService(accessory, Service.Switch, config.enableSwitch);
 *
 * // Keep a service if it currently exists, or add it if a certain condition is met
 * validService(accessory, Service.Switch, (hasService) => hasService || config.enableSwitch);
 * ```
 *
 * @category Accessory
 */
export function validService(accessory: PlatformAccessory, serviceType: WithUUID<typeof Service>, validate: boolean | ((hasService: boolean) => boolean),
  subtype?: string): boolean {

  // Find the service, if it exists.
  const service = subtype ? accessory.getServiceById(serviceType, subtype) : accessory.getService(serviceType);

  // Validate whether we should have the service. If not, remove it.
  if(!((typeof validate === "function") ? validate(!!service) : validate)) {

    if(service) {

      accessory.removeService(service);
    }

    return false;
  }

  // We have a valid service.
  return true;
}
