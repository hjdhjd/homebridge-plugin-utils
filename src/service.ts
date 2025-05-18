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
 * Utility method that either creates a new service on an accessory, if needed, or returns an existing one. It optionally executes a callback to initialize a new
 * instance of a service, if needed. Additionally, the various name characteristics of the service will be set to the specified name, optionally adding them as needed.
 *
 * @param hap             - HAP instance associated with the Homebridge plugin.
 * @param accessory       - Homebridge accessory to check.
 * @param serviceType     - Service type that is being instantiated or retrieved.
 * @param name            - Name to be displayed to the end user for this service.
 * @param subtype         - Service subtype, if needed.
 * @param onServiceCreate - Callback to be used when a new service is created. It is not called when an existing service is found.
 *
 * @returns Returns the created or retrieved service, `null` otherwise.
 *
 * @remarks `onServiceCreate` is called with the newly created service as an argument to allow the caller to optionally configure it.
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
 * Validate whether a service should exist, removing it if needed.
 *
 * @param accessory       - Homebridge accessory to check.
 * @param serviceType     - Service type that is being instantiated or retrieved.
 * @param validate        - Function to be used to test whether a service should exist or not.
 * @param subtype         - Service subtype, if needed.
 *
 * @returns Returns `true` if the service is valid, will remove the service and return `false` otherwise.
 *
 * @remarks `validate` is called with an argument of `true` if the service currently exists on the accessory and `false` otherwise.
 *
 * @category Accessory
 */
export function validService(accessory: PlatformAccessory, serviceType: WithUUID<typeof Service>, validate: (hasService: boolean) => boolean, subtype?: string): boolean {

  // Find the switch service, if it exists.
  const service = subtype ? accessory.getServiceById(serviceType, subtype) : accessory.getService(serviceType);

  // Validate whether we should have the service. If not, remove it.
  if(!validate(!!service)) {

    if(service) {

      accessory.removeService(service);
    }

    return false;
  }

  // We have a valid service.
  return true;
}
