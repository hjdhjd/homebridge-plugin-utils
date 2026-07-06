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
import type { Nullable } from "./util.ts";
import { sanitizeName } from "./util.ts";

// Cached Sets for O(1) service UUID lookups. Lazily initialized on first use.
let requiresConfiguredNameUUIDs: Nullable<Set<string>> = null;
let hasConfiguredNameUUIDs: Nullable<Set<string>> = null;
let requiresNameUUIDs: Nullable<Set<string>> = null;
let hasNameUUIDs: Nullable<Set<string>> = null;

// Retrieves the Characteristic constructor from a service instance. Homebridge's HAP types don't expose a direct way to access the Characteristic constructor from a
// service without holding a reference to the HAP object itself. This reflection pattern extracts it from the first characteristic on any service instance, which always
// exists (every service has at least one required characteristic). Centralized here so the fragile cast lives in one place.
function getCharacteristicConstructor(service: Service): typeof Characteristic {

  // Every HAP service is constructed with at least one required characteristic, so the first slot is always populated. The explicit check satisfies
  // `noUncheckedIndexedAccess` and throws loudly in the unreachable event that a service arrives without characteristics.
  const [first] = service.characteristics;

  if(!first) {

    throw new Error("Service has no characteristics; cannot resolve the Characteristic constructor.");
  }

  return first.constructor as unknown as typeof Characteristic;
}

/**
 * Initializes the cached UUID Sets for service characteristic lookups.
 *
 * @param service - Any service instance, used to access the Service constructor and its static UUID properties.
 *
 * @internal
 */
function initServiceUUIDSets(service: Service): void {

  if(requiresConfiguredNameUUIDs) {

    return;
  }

  // Grab the constructor from the instance of our service so we can access the static UUID properties. HAP's static service entries are populated unconditionally at
  // module load, so the UUID lookup is total in practice. We centralize the `undefined` handling here so the individual Set contents read cleanly.
  const ctor = service.constructor as unknown as Record<string, { UUID: string } | undefined>;
  const uuidOf = (name: string): string => ctor[name]?.UUID ?? "";

  requiresConfiguredNameUUIDs = new Set([ "InputSource", "Television", "WiFiRouter" ].map(uuidOf));

  // The "has" sets are supersets of the "requires" sets - any service that requires a characteristic also supports it. Call sites combine the two predicates as
  // `!serviceRequires(...) && serviceHas(...)` to detect the optional-but-supported case.
  hasConfiguredNameUUIDs = new Set([

    "AccessoryInformation", "ContactSensor", "InputSource", "Lightbulb", "MotionSensor", "OccupancySensor", "SmartSpeaker", "Switch", "Television", "Valve", "WiFiRouter"
  ].map(uuidOf));

  requiresNameUUIDs = new Set([ "AccessoryInformation", "Assistant", "InputSource" ].map(uuidOf));

  hasNameUUIDs = new Set([

    "AccessoryInformation", "AirPurifier", "AirQualitySensor", "Assistant", "Battery", "CarbonDioxideSensor", "CarbonMonoxideSensor", "ContactSensor", "Door", "Doorbell",
    "Fan", "Fanv2", "Faucet", "FilterMaintenance", "GarageDoorOpener", "HeaterCooler", "HumidifierDehumidifier", "HumiditySensor", "InputSource", "IrrigationSystem",
    "LeakSensor", "Lightbulb", "LightSensor", "LockMechanism", "MotionSensor", "OccupancySensor", "Outlet", "SecuritySystem", "Slats", "SmartSpeaker", "SmokeSensor",
    "StatefulProgrammableSwitch", "StatelessProgrammableSwitch", "Switch", "TargetControl", "Television", "TemperatureSensor", "Thermostat", "Valve", "Window",
    "WindowCovering"
  ].map(uuidOf));
}

/**
 * The constructor shape {@link acquireService} expects for a Service subclass. Every HAP Service subclass (Lightbulb, Switch, Television, ...) satisfies both halves
 * of this intersection naturally:
 *
 * - `WithUUID<typeof Service>` - provides the static `UUID` property AND assignability to HAP's `getService` / `getServiceById` lookup APIs that require this exact
 *   shape.
 * - `new (displayName?: string, subtype?: string) => T` - the actual runtime constructor signature every Service subclass exposes; supersedes the BASE Service
 *   class's `(displayName, UUID, subtype?)` signature that the wider `WithUUID<typeof Service>` would otherwise surface.
 *
 * Intersecting both shapes lets the function invoke `new serviceType(name, subtype)` against an honest type-checked signature without any cast or non-null assertion.
 *
 * @typeParam T - The concrete Service subclass produced by the constructor. Inferred from the call site so callers receive the specific subclass type back.
 *
 * @category Accessory
 */
export type AcquireServiceTarget<T extends Service = Service> = WithUUID<typeof Service> & (new (displayName?: string, subtype?: string) => T);

/**
 * Utility method that either creates a new service on an accessory if needed, or returns an existing one. Optionally, it executes a callback to initialize a new
 * service instance. Additionally, the various name characteristics of the service are set to the specified name, and optionally added if necessary.
 *
 * @typeParam T          - The concrete Service subclass being acquired. Inferred from `serviceType` so callers receive the specific subclass type back rather than
 *                         the wider `Service` type.
 * @param accessory       - The Homebridge accessory to check or modify.
 * @param serviceType     - The type of service to instantiate or retrieve. Must be a HAP Service subclass with the standard `(displayName?, subtype?)` constructor;
 *                         see {@link AcquireServiceTarget}.
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
 * // Example: Ensure a Lightbulb service exists with a user-friendly name, and initialize it if newly created. The return type is narrowed to `Lightbulb | null`,
 * // so callers can invoke subclass-specific behavior on the result without casts.
 * const lightbulbService = acquireService(accessory, hap.Service.Lightbulb, "Living Room Lamp", undefined, (svc): void => {
 *
 *   // Called only if the service is newly created. `svc` is typed as `Lightbulb` here.
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
 * @see setServiceName - updates the newly created (or existing) service's name-related characteristics.
 * @see validService - validate or prune services after acquisition.
 * @category Accessory
 */
export function acquireService<T extends Service>(accessory: PlatformAccessory, serviceType: AcquireServiceTarget<T>, name: string, subtype?: string,
  onServiceCreate?: (svc: T) => void): Nullable<T> {

  // Sanitize once up front because HomeKit's strict naming rules apply both to the constructor's displayName and to the ConfiguredName / Name characteristics that
  // setServiceName populates - same source string, same validation contract.
  const sanitized = sanitizeName(name);

  // Find the service, if it exists. The cast back to `T` is sound because `getService` / `getServiceById` look up by the constructor's UUID brand, and the only
  // service registered against that UUID is one this function (or a sibling caller using the same constructor) created - i.e., an instance of `T`.
  let service = (subtype ? accessory.getServiceById(serviceType, subtype) : accessory.getService(serviceType)) as T | undefined;

  if(!service) {

    // The narrow constructor signature in `AcquireServiceTarget<T>` lets us invoke `new serviceType(name, subtype)` directly - no cast, no non-null assertion. The
    // type system expresses what the runtime requires: callers pass a Service subclass with the standard `(displayName?, subtype?)` constructor.
    service = new serviceType(sanitized, subtype);

    const characteristic = getCharacteristicConstructor(service);

    // Add the Configured Name characteristic if we don't already have it and it's available to us.
    if(!serviceRequiresConfiguredName(service) && serviceHasConfiguredName(service) &&
      !service.optionalCharacteristics.some(x => (x.UUID === characteristic.ConfiguredName.UUID))) {

      service.addOptionalCharacteristic(characteristic.ConfiguredName);
    }

    // Add the Name characteristic if we don't already have it and it's available to us.
    if(!serviceRequiresName(service) && serviceHasName(service) && !service.optionalCharacteristics.some(x => (x.UUID === characteristic.Name.UUID))) {

      service.addOptionalCharacteristic(characteristic.Name);
    }

    setServiceName(service, sanitized);

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
 * @see acquireService - to add or retrieve services.
 * @category Accessory
 */
export function validService(accessory: PlatformAccessory, serviceType: WithUUID<typeof Service>, validate: boolean | ((hasService: boolean) => boolean),
  subtype?: string): boolean {

  const service = subtype ? accessory.getServiceById(serviceType, subtype) : accessory.getService(serviceType);

  // Resolve `validate` against the current presence and remove the service when the validator votes false. The function-form receives the actual presence boolean so
  // callers can express add-if-missing semantics like `(has) => has || config.enableSwitch`.
  if(!((typeof validate === "function") ? validate(!!service) : validate)) {

    if(service) {

      accessory.removeService(service);
    }

    return false;
  }

  return true;
}

/**
 * Build a `validService` predicate for a service gated on a hardware capability and a user toggle, applying an additive-eager / subtractive-conservative asymmetry
 * between the two: the user `toggle` is absolute - when false, the service is removed - while the hardware `capability` is conservative - an existing service is kept
 * through a transient capability-false, and a new service is created only when the capability reports.
 *
 * @param options - The `capability` and `toggle` inputs for the gate.
 *
 * @returns A `validService` function-form predicate, `(hasService) => toggle && (hasService || capability)`.
 *
 * @remarks
 * Pass the result as `validService`'s `validate` argument. The asymmetry keeps a capability-gated service from being removed during a transient window in which the
 * device under-reports its capability, while still honoring a user who disables the service. A service with no user toggle should gate on its capability directly.
 *
 * @example
 * ```typescript
 * // Keep the service while its user toggle is on, add it when the capability reports, and keep an existing one through a transient capability-false.
 * validService(accessory, Service.Switch, capabilityGate({ capability: deviceReportsFeature, toggle: config.enableSwitch }));
 * ```
 *
 * @see validService - consumes the returned predicate.
 * @category Accessory
 */
export function capabilityGate({ capability, toggle }: { capability: boolean; toggle: boolean }): (hasService: boolean) => boolean {

  return hasService => toggle && (hasService || capability);
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
 * @returns `true` if the service type supports the ConfiguredName characteristic.
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
 * @returns `true` if the service type supports the Name characteristic.
 *
 * @internal
 */
function serviceHasName(service: Service): boolean {

  initServiceUUIDSets(service);

  return hasNameUUIDs?.has(service.UUID) ?? false;
}

/**
 * Retrieves the primary name of a service, preferring the ConfiguredName characteristic over the Name characteristic. This is a pure read - it never mutates the
 * service.
 *
 * @param service - The service from which to retrieve the name.
 * @returns The configured or display name of the service, or `undefined` if neither characteristic is present or set.
 *
 * @see setServiceName - to update the current name on a service.
 * @category Accessory
 */
export function getServiceName(service?: Service): string | undefined {

  if(!service) {

    return undefined;
  }

  const characteristic = getCharacteristicConstructor(service);

  // HAP's `getCharacteristic` is get-or-create: asking for a characteristic the service does not have constructs it, attaches it to the service, and (for types
  // outside the service's optional set) logs an "Adding anyway." warning. A name lookup must stay read-only, so we gate each read behind `testCharacteristic` - a
  // pure existence check - and read a value only when the characteristic is already present. ConfiguredName takes precedence over Name.
  const configuredName = service.testCharacteristic(characteristic.ConfiguredName) ? service.getCharacteristic(characteristic.ConfiguredName).value : undefined;
  const name = service.testCharacteristic(characteristic.Name) ? service.getCharacteristic(characteristic.Name).value : undefined;

  return (configuredName ?? name ?? undefined) as string | undefined;
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
 * @see acquireService - to add or retrieve services.
 * @see getServiceName - to retrieve the current name set on a service.
 * @category Accessory
 */
export function setServiceName(service: Service, name: string): void {

  const characteristic = getCharacteristicConstructor(service);
  const sanitized = sanitizeName(name);

  service.displayName = sanitized;

  if(serviceHasConfiguredName(service)) {

    service.updateCharacteristic(characteristic.ConfiguredName, sanitized);
  }

  if(serviceHasName(service)) {

    service.updateCharacteristic(characteristic.Name, sanitized);
  }
}
