/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * service.ts: Useful Homebridge service support functions.
 */

/**
 * Homebridge service helper utilities.
 *
 * @module
 */
import type { Characteristic, PlatformAccessory, Service, WithUUID } from "homebridge";
import { type Nullable, sanitizeName } from "./util.js";

// Cached Sets for O(1) service UUID lookups. Lazily initialized on first use.
let requiresConfiguredNameUUIDs: Nullable<Set<string>> = null;
let hasConfiguredNameUUIDs: Nullable<Set<string>> = null;
let requiresNameUUIDs: Nullable<Set<string>> = null;
let hasNameUUIDs: Nullable<Set<string>> = null;

/**
 * Initializes the cached UUID Sets for service characteristic lookups.
 *
 * @param service - Any service instance, used to access the Service constructor and its static UUID properties.
 *
 * @internal
 */
function initServiceUUIDSets(service: Service): void {

  // Already initialized.
  if(requiresConfiguredNameUUIDs) {

    return;
  }

  // Grab the constructor from the instance of our service so we can access the static UUID properties.
  const ctor = service.constructor as unknown as Record<string, { UUID: string }>;

  // Services that require the ConfiguredName characteristic.
  requiresConfiguredNameUUIDs = new Set([

    ctor.InputSource.UUID, ctor.Television.UUID, ctor.WiFiRouter.UUID
  ]);

  // Services that support the ConfiguredName characteristic (includes required).
  hasConfiguredNameUUIDs = new Set([

    ctor.AccessoryInformation.UUID, ctor.ContactSensor.UUID, ctor.InputSource.UUID, ctor.Lightbulb.UUID, ctor.MotionSensor.UUID,
    ctor.OccupancySensor.UUID, ctor.SmartSpeaker.UUID, ctor.Switch.UUID, ctor.Television.UUID, ctor.Valve.UUID, ctor.WiFiRouter.UUID
  ]);

  // Services that require the Name characteristic.
  requiresNameUUIDs = new Set([

    ctor.AccessoryInformation.UUID, ctor.Assistant.UUID, ctor.InputSource.UUID
  ]);

  // Services that support the Name characteristic (includes required).
  hasNameUUIDs = new Set([

    ctor.AccessoryInformation.UUID, ctor.AirPurifier.UUID, ctor.AirQualitySensor.UUID, ctor.Assistant.UUID, ctor.Battery.UUID,
    ctor.CarbonDioxideSensor.UUID, ctor.CarbonMonoxideSensor.UUID, ctor.ContactSensor.UUID, ctor.Door.UUID, ctor.Doorbell.UUID,
    ctor.Fan.UUID, ctor.Fanv2.UUID, ctor.Faucet.UUID, ctor.FilterMaintenance.UUID, ctor.GarageDoorOpener.UUID, ctor.HeaterCooler.UUID,
    ctor.HumidifierDehumidifier.UUID, ctor.HumiditySensor.UUID, ctor.InputSource.UUID, ctor.IrrigationSystem.UUID, ctor.LeakSensor.UUID,
    ctor.Lightbulb.UUID, ctor.LightSensor.UUID, ctor.LockMechanism.UUID, ctor.MotionSensor.UUID, ctor.OccupancySensor.UUID, ctor.Outlet.UUID,
    ctor.SecuritySystem.UUID, ctor.Slats.UUID, ctor.SmartSpeaker.UUID, ctor.SmokeSensor.UUID, ctor.StatefulProgrammableSwitch.UUID,
    ctor.StatelessProgrammableSwitch.UUID, ctor.Switch.UUID, ctor.TargetControl.UUID, ctor.Television.UUID, ctor.TemperatureSensor.UUID,
    ctor.Thermostat.UUID, ctor.Valve.UUID, ctor.Window.UUID, ctor.WindowCovering.UUID
  ]);
}

/**
 * Utility method that either creates a new service on an accessory if needed, or returns an existing one. Optionally, it executes a callback to initialize a new
 * service instance. Additionally, the various name characteristics of the service are set to the specified name, and optionally added if necessary.
 *
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
 * const lightbulbService = acquireService(accessory, hap.Service.Lightbulb, "Living Room Lamp", undefined, (svc: Service): void => {
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
 * @see setServiceName — updates the newly created (or existing) service’s name-related characteristics.
 * @see validService — validate or prune services after acquisition.
 * @category Accessory
 */
export function acquireService(accessory: PlatformAccessory, serviceType: WithUUID<typeof Service>, name: string, subtype?: string,
  onServiceCreate?: (svc: Service) => void): Nullable<Service> {

  // Ensure we have HomeKit approved naming.
  name = sanitizeName(name);

  // Find the service, if it exists.
  let service = subtype ? accessory.getServiceById(serviceType, subtype) : accessory.getService(serviceType);

  // Add the service to the accessory, if needed.
  if(!service) {

    service = new serviceType(name, subtype as string);

    // Grab the Characteristic constructor from the instance of our service so we can set the individual characteristics without needing the HAP object directly.
    const characteristic = service.characteristics[0].constructor as unknown as typeof Characteristic;

    // Add the Configured Name characteristic if we don't already have it and it's available to us.
    if(!serviceRequiresConfiguredName(service) && serviceHasConfiguredName(service) &&
      !service.optionalCharacteristics.some(x => (x.UUID === characteristic.ConfiguredName.UUID))) {

      service.addOptionalCharacteristic(characteristic.ConfiguredName);
    }

    // Add the Name characteristic if we don't already have it and it's available to us.
    if(!serviceRequiresName(service) && serviceHasName(service) && !service.optionalCharacteristics.some(x => (x.UUID === characteristic.Name.UUID))) {

      service.addOptionalCharacteristic(characteristic.Name);
    }

    // Set our name.
    setServiceName(service, name);

    accessory.addService(service);

    if(onServiceCreate) {

      onServiceCreate(service);
    }
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
 * @see acquireService — to add or retrieve services.
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

/**
 * Determines whether the specified service type requires the ConfiguredName characteristic.
 *
 * @param service - The service instance to check.
 * @returns `true` if the service type requires the ConfiguredName characteristic.
 *
 * @internal
 */
function serviceRequiresConfiguredName(service: Service): boolean {

  initServiceUUIDSets(service);

  return requiresConfiguredNameUUIDs?.has(service.UUID) ?? false;
}

/**
 * Determines whether the specified service type supports the ConfiguredName characteristic.
 *
 * @param service - The service instance to check.
 * @returns `true` if the service type needs the ConfiguredName characteristic maintained.
 *
 * @internal
 */
function serviceHasConfiguredName(service: Service): boolean {

  initServiceUUIDSets(service);

  return hasConfiguredNameUUIDs?.has(service.UUID) ?? false;
}

/**
 * Determines whether the specified service type requires the Name characteristic.
 *
 * @param service - The service instance to check.
 * @returns `true` if the service type requires the Name characteristic.
 *
 * @internal
 */
function serviceRequiresName(service: Service): boolean {

  initServiceUUIDSets(service);

  return requiresNameUUIDs?.has(service.UUID) ?? false;
}

/**
 * Determines whether the specified service type supports the Name characteristic.
 *
 * @param service - The service instance to check.
 * @returns `true` if the service type needs the Name characteristic maintained.
 *
 * @internal
 */
function serviceHasName(service: Service): boolean {

  initServiceUUIDSets(service);

  return hasNameUUIDs?.has(service.UUID) ?? false;
}

/**
 * Retrieves the primary name of a service, preferring the ConfiguredName characteristic over the Name characteristic.
 *
 * @param service - The service from which to retrieve the name.
 * @returns The configured or display name of the service, or `undefined` if neither is set.
 *
 * @see setServiceName — to update the current name n a service.
 * @category Accessory
 */
export function getServiceName(service?: Service): string | undefined {

  // No service, we're done.
  if(!service) {

    return undefined;
  }

  // Grab the Characteristic constructor from the instance of our service so we can set the individual characteristics without needing the HAP object directly.
  const characteristic = service.characteristics[0].constructor as unknown as typeof Characteristic;

  return (service.getCharacteristic(characteristic.ConfiguredName).value ?? service.getCharacteristic(characteristic.Name).value ?? undefined) as string | undefined;
}

/**
 * Updates the displayName and applicable name characteristics of a service to the specified value.
 *
 * @param service - The service to update.
 * @param name    - The new name to apply to the service.
 *
 * @remarks
 * This function ensures the name is validated, updates the service's `displayName`, and sets the `ConfiguredName` and `Name`
 * characteristics when supported by the service type.
 *
 * @see acquireService — to add or retrieve services.
 * @see getServiceName — to retrieve the current name set on a service.
 * @category Accessory
 */
export function setServiceName(service: Service, name: string): void {

  // Grab the Characteristic constructor from the instance of our service so we can set the individual characteristics without needing the HAP object directly.
  const characteristic = service.characteristics[0].constructor as unknown as typeof Characteristic;

  // Ensure we have HomeKit approved naming.
  name = sanitizeName(name);

  // Update our name.
  service.displayName = name;

  if(serviceHasConfiguredName(service)) {

    service.updateCharacteristic(characteristic.ConfiguredName, name);
  }

  if(serviceHasName(service)) {

    service.updateCharacteristic(characteristic.Name, name);
  }
}
