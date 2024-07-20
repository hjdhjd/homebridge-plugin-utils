/* Copyright(C) 2017-2024, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * service.ts: Useful Homebridge service support functions.
 */
import { HAP, PlatformAccessory, Service, WithUUID } from "homebridge";

/**
 * Utility method that either creates a new service on an accessory, if needed, or returns an existing one. It optionally executes a callback to initialize a new
 * instance of a service, if needed. Additionally, the various name characteristics of the service will be set to the specified name, optionally adding them as needed.
 * @param hap             - HAP instance associated with the Homebridge plugin.
 * @param accessory       - Homebridge accessory to check.
 * @param serviceType     - Service type that is being instantiated or retrieved.
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
  onServiceCreate?: (svc: Service) => void): Service | null {

  // Services that need the ConfiguredName characteristic added and maintained.
  const configuredNameServices = [ hap.Service.ContactSensor, hap.Service.Lightbulb, hap.Service.MotionSensor, hap.Service.OccupancySensor, hap.Service.Switch ];

  // Services that need the Name characteristic maintained.
  const nameServices = [ hap.Service.Battery, hap.Service.ContactSensor, hap.Service.HumiditySensor, hap.Service.LeakSensor, hap.Service.Lightbulb,
    hap.Service.LightSensor, hap.Service.MotionSensor, hap.Service.TemperatureSensor ];

  // Find the service, if it exists.
  let service = subtype ? accessory.getServiceById(serviceType, subtype) : accessory.getService(serviceType);

  // Add the service to the accessory, if needed.
  if(!service) {

    // @ts-expect-error TypeScript tries to associate this with an overloaded version of the addService method. However, Homebridge/HAP-NodeJS isn't exporting
    // a version of the method that implements the unexposed interface that's been defined for each service class (e.g. Lightbulb). The constructor on the
    // service-type-specific version of the service takes the following arguments: constructor(displayName?: string, subtype?: string). We're safe, but because
    // the type definitions are missing, we need to override it here.
    service = new serviceType(name, subtype);

    if(!service) {

      return null;
    }

    accessory.addService(service);

    if(onServiceCreate) {

      onServiceCreate(service);
    }
  }

  // Update our name.
  service.displayName = name;

  if(configuredNameServices.includes(serviceType)) {

    // Add the characteristic if we don't already have it. We do this here instead of at service creation to ensure we catch legacy situations where we may have
    // already created the service previously without adding the optional characteristics we want.
    if(!service.optionalCharacteristics.some(x => (x.UUID === hap.Characteristic.ConfiguredName.UUID))) {

      service.addOptionalCharacteristic(hap.Characteristic.ConfiguredName);
    }

    service.updateCharacteristic(hap.Characteristic.ConfiguredName, name);
  }

  if(nameServices.includes(serviceType)) {

    service.updateCharacteristic(hap.Characteristic.Name, name);
  }

  return service;
}

/**
 * Validate whether a service should exist, removing it if needed.
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
