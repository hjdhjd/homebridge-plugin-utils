/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * service.ts: Useful Homebridge service support functions.
 */

/**
 * Homebridge service helper utilities.
 *
 * @module
 */
import type { Characteristic, CharacteristicSetHandler, CharacteristicValue, PlatformAccessory, Service, WithUUID } from "homebridge";
import { HAPStatus } from "./homebridge-enums.ts";
import type { Nullable } from "./util.ts";
import { sanitizeName } from "./homekit-name.ts";

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

    "AccessoryInformation", "ContactSensor", "InputSource", "Lightbulb", "MotionSensor", "OccupancySensor", "SmartSpeaker", "StatelessProgrammableSwitch", "Switch",
    "Television", "Valve", "WiFiRouter"
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
 * Intersecting both shapes lets the function invoke `new serviceType(sanitized, subtype)` against an honest type-checked signature without any cast or non-null
 * assertion.
 *
 * @typeParam T - The concrete Service subclass produced by the constructor. Inferred from the call site so callers receive the specific subclass type back.
 *
 * @category Accessory
 */
export type AcquireServiceTarget<T extends Service = Service> = WithUUID<typeof Service> & (new (displayName?: string, subtype?: string) => T);

/**
 * The characteristic class both HAP calls in {@link updateServices} are handed: `testCharacteristic` matches a service's attached characteristics against the class's
 * static `UUID`, while `updateCharacteristic` takes the same class as something it can construct from, since HAP builds the characteristic when the service it is
 * called on does not already carry one. Intersecting both shapes lets a caller hand over `Characteristic.StatusActive` and have each call type-check against the
 * half of the shape it actually uses, with no cast at the call site.
 *
 * @category Accessory
 */
export type CharacteristicTarget = WithUUID<typeof Characteristic> & (new () => Characteristic);

/**
 * The inputs {@link findService} identifies a service by: the accessory, the service type, and an optional subtype disambiguating more than one service of the
 * same type.
 *
 * @typeParam T - The concrete Service subclass being looked up. Inferred from `serviceType` so callers receive the specific subclass type back.
 *
 * @category Accessory
 */
export interface FindServiceOptions<T extends Service = Service> {

  /**
   * The Homebridge accessory to check or modify.
   */
  readonly accessory: PlatformAccessory;

  /**
   * The type of service to instantiate or retrieve. Must be a HAP Service subclass with the standard `(displayName?, subtype?)` constructor; see
   * {@link AcquireServiceTarget}.
   */
  readonly serviceType: AcquireServiceTarget<T>;

  /**
   * Optional service subtype to uniquely identify the service.
   */
  readonly subtype?: string;
}

/**
 * The inputs {@link acquireService} creates or retrieves a service from: everything {@link findService} identifies the service by, plus the display name a newly
 * created service takes and an optional callback fired only on creation.
 *
 * @typeParam T - The concrete Service subclass being acquired. Inferred from `serviceType` so callers receive the specific subclass type back.
 *
 * @category Accessory
 */
export interface AcquireServiceOptions<T extends Service = Service> extends FindServiceOptions<T> {

  /**
   * Name to be displayed to the end user for this service.
   */
  readonly name: string;

  /**
   * Optional callback invoked only when a new service is created, receiving the new service as its argument.
   */
  readonly onServiceCreate?: (svc: T) => void;
}

/**
 * The service {@link acquireService} answers, and the transition it performed to answer it: `"attached"` when this call created the service, `"kept"`
 * when it already existed. This is the present arm of {@link ValidServiceResult}, reused rather than declared a second time, since a successful
 * acquisition and a validated service that already existed or was just created are the same fact.
 *
 * @category Accessory
 */
export interface AcquireServiceResult<T extends Service = Service> {

  /**
   * The service {@link acquireService} found or created.
   */
  readonly service: T;

  /**
   * The transition this call performed to answer the service: `"attached"` when this call created it, `"kept"` when it already existed.
   */
  readonly transition: Extract<PresenceTransition, "attached" | "kept">;
}

/**
 * Finds the service {@link acquireService} would create for the same type and subtype, and nothing else. A service matches when it carries the type's UUID and
 * the same subtype, where an empty subtype and no subtype are one identity, as they are in HAP's own service identity. A lookup without a subtype therefore never
 * answers a subtyped sibling of the same type. HAP's `getService` matches by type alone and ignores the subtype, which is why this module owns the lookup rather
 * than delegating it.
 *
 * @typeParam T    - The concrete Service subclass being looked up. Inferred from `serviceType` so callers receive the specific subclass type back.
 * @param options - The accessory, the service type, and an optional subtype. See {@link FindServiceOptions}.
 *
 * @returns The matching service, or `undefined` when the accessory carries none.
 *
 * @category Accessory
 */
export function findService<T extends Service>({ accessory, serviceType, subtype }: FindServiceOptions<T>): T | undefined {

  // The cast to `T` is sound because a service carrying the constructor's UUID and this subtype is one `new serviceType(name, subtype)` produced, whether this
  // module created it or a caller using the same constructor did.
  return accessory.services.find((service) => (service.UUID === serviceType.UUID) && ((service.subtype ?? "") === (subtype ?? ""))) as T | undefined;
}

/**
 * Adds a newly constructed service to an accessory, making room first when HAP would otherwise refuse it. HAP rejects a subtype-less service while any
 * service of the same type is on the accessory, yet accepts that end state built in the other order, so a subtype-less service joining subtyped siblings goes
 * on while the siblings are briefly detached. The same sibling instances go back on afterward, and every link list that named one of them is restored to its
 * exact prior contents and order, whether or not the addition succeeds.
 *
 * @param accessory - The accessory receiving the service.
 * @param service   - The newly constructed service to add. The caller has already established that the accessory carries no subtype-less service of its type.
 *
 * @internal
 */
function addServiceMakingRoom(accessory: PlatformAccessory, service: Service): void {

  // A subtyped service, or one with no service of its type beside it, passes HAP's check as things stand, so it is added directly and pays for nothing more.
  // Every service of the type found here is a subtyped sibling, since the caller found no subtype-less match.
  const siblings = service.subtype ? [] : accessory.services.filter((existing) => existing.UUID === service.UUID);

  if(!siblings.length) {

    accessory.addService(service);

    return;
  }

  // Snapshot every link list that names a sibling before anything is detached. HAP strips a removed service from the links of every service still on the
  // accessory, a sibling that links to another sibling included, so a snapshot taken after the first removal would already be missing entries.
  const links = accessory.services.filter((linker) => linker.linkedServices.some((linked) => siblings.includes(linked)))
    .map((linker) => ({ linked: [...linker.linkedServices], linker }));

  for(const sibling of siblings) {

    accessory.removeService(sibling);
  }

  // Siblings go back through HAP's own addService, which re-installs HAP's event wiring on each one and re-derives the accessory's primaryService from its flag.
  // A sibling already back on the accessory is skipped, so the failure path below can run this again without adding anything twice.
  const reattach = (): void => {

    for(const sibling of siblings) {

      if(!accessory.services.includes(sibling)) {

        accessory.addService(sibling);
      }
    }
  };

  try {

    accessory.addService(service);
    reattach();
  } catch(error) {

    // Either HAP refused the new service, or it went on and took the last slot HAP's service limit allows, leaving a sibling nowhere to go. Taking the new service
    // back off answers both, since removeService ignores a service the accessory does not carry, and the siblings then return to the accessory as it was.
    accessory.removeService(service);
    reattach();

    throw error;
  } finally {

    // Restore each link list in place. Re-linking through addLinkedService would append, reordering any list that also names services outside the siblings.
    for(const { linked, linker } of links) {

      linker.linkedServices.splice(0, linker.linkedServices.length, ...linked);
    }
  }
}

/**
 * Reconciles a service's presence on an accessory in one call: creates it when it does not exist, or returns it unchanged when it does. Optionally
 * executes a callback to initialize a newly created service. For a newly created service, the various name characteristics are also set to the
 * specified name and added where necessary; re-acquiring an existing service returns it with its name characteristics untouched.
 *
 * @typeParam T    - The concrete Service subclass being acquired. Inferred from `serviceType` so callers receive the specific subclass type back rather
 *                   than the wider `Service` type.
 * @param options - The accessory, the display name, the service type, an optional subtype, and an optional creation callback. See
 *                   {@link AcquireServiceOptions}.
 *
 * @returns The service and the transition this call performed to answer it - `"attached"` when this call created the service, `"kept"` when it already
 * existed. See {@link AcquireServiceResult}. Construction failures throw rather than answering a result.
 *
 * @remarks
 * This method ensures that a newly created service's display name and available name characteristics are updated to the specified name; re-acquiring an
 * existing service leaves its name characteristics untouched, so a caller renaming an existing service calls {@link setServiceName} directly. If
 * `onServiceCreate` is provided, it will only be called for newly created services, not for existing ones.
 *
 * A call without a subtype on an accessory that already carries subtyped services of the type creates the subtype-less service beside them. HAP refuses a
 * subtype-less service while any service of its type is on the accessory, yet accepts the same end state built in the other order, so the call makes room: it
 * detaches the subtyped siblings, adds the new service, re-adds the same sibling instances, and restores every link list that named a sibling to its exact prior
 * contents and order. When the new service cannot be added, including when HAP's service limit leaves no room for the siblings to follow it, the siblings and
 * their links are restored before the error propagates, leaving the accessory as it was. `onServiceCreate` runs once the new service and every sibling are on
 * the accessory.
 *
 * HomeKit keys a service's identity on its accessory, type, and subtype rather than on the object, so a re-added sibling keeps its instance ids, name,
 * characteristics, and characteristic handlers, and the automations that reference it survive. The accessory's `primaryService` re-derives itself from a
 * sibling's primary flag as the sibling is re-added. HAP's `removeService` clears every listener on the Service it detaches and re-installs only its own on the
 * way back, so a listener a plugin attached directly to a sibling Service's own event emitter is lost and has to be attached again. `PlatformAccessory.addService`
 * and `removeService` forward straight to the HAP accessory, so all of this holds for a platform accessory as it does for a bare HAP one.
 *
 * The `ConfiguredName` and `Name` characteristics are conditionally added or updated based on the type of service, in accordance with HomeKit requirements.
 *
 * @example
 * ```typescript
 * // Ensure a Lightbulb service exists with a user-friendly name, and initialize it if newly created. The return narrows to `Lightbulb`, so callers
 * // invoke subclass-specific behavior on the result without casts.
 * const { service: lightbulbService } = acquireService({ accessory, name: "Living Room Lamp", onServiceCreate: (svc): void => {
 *
 *   // Called only if the service is newly created. `svc` is typed as `Lightbulb` here.
 *   svc.setCharacteristic(hap.Characteristic.On, false);
 * }, serviceType: hap.Service.Lightbulb });
 *
 * // Service is now available, with display name set and optional characteristics managed.
 * lightbulbService.updateCharacteristic(hap.Characteristic.Brightness, 75);
 *
 * // Read whether this call created the service from the result, instead of threading a separate flag through onServiceCreate.
 * const { service: switchService, transition } = acquireService({ accessory, name: "Suspend All Zones", serviceType: hap.Service.Switch });
 * const isNewSwitch = transition === "attached";
 * ```
 *
 * @see setServiceName - updates the newly created (or existing) service's name-related characteristics.
 * @see validService - reconciles a service's presence from a verdict, creating through this function when the verdict says it should exist.
 * @category Accessory
 */
export function acquireService<T extends Service>({ accessory, name, onServiceCreate, serviceType, subtype }: AcquireServiceOptions<T>): AcquireServiceResult<T> {

  // Sanitize once up front because HomeKit's strict naming rules apply both to the constructor's displayName and to the ConfiguredName / Name characteristics that
  // setServiceName populates - same source string, same validation contract.
  const sanitized = sanitizeName(name);

  // Find the service this call would create, if the accessory already carries it. The matching rule is findService's own.
  let service = findService({ accessory, serviceType, subtype });

  if(!service) {

    // The narrow constructor signature in `AcquireServiceTarget<T>` lets us invoke `new serviceType(sanitized, subtype)` directly - no cast, no non-null assertion.
    // The type system expresses what the runtime requires: callers pass a Service subclass with the standard `(displayName?, subtype?)` constructor.
    service = new serviceType(sanitized, subtype);

    const characteristic = getCharacteristicConstructor(service);

    // HAP can pre-populate ConfiguredName in a freshly-constructed service's default optional set, so this guard prevents adding it a second time within this single
    // construction. Re-acquisition of an already-existing service is a separate case, already gated by the `!service` check above.
    if(!serviceRequiresConfiguredName(service) && serviceHasConfiguredName(service) &&
      !service.optionalCharacteristics.some(x => (x.UUID === characteristic.ConfiguredName.UUID))) {

      service.addOptionalCharacteristic(characteristic.ConfiguredName);
    }

    // Same duplicate-guard rationale as the ConfiguredName check above, applied to the Name characteristic.
    if(!serviceRequiresName(service) && serviceHasName(service) && !service.optionalCharacteristics.some(x => (x.UUID === characteristic.Name.UUID))) {

      service.addOptionalCharacteristic(characteristic.Name);
    }

    setServiceName(service, sanitized);

    // The addition makes room when a subtype-less service joins subtyped siblings, so the service onServiceCreate receives is on the accessory with every
    // sibling back beside it.
    addServiceMakingRoom(accessory, service);

    if(onServiceCreate) {

      onServiceCreate(service);
    }

    return { service, transition: "attached" };
  }

  return { service, transition: "kept" };
}

/**
 * The inputs {@link validService} reconciles a service's presence from: everything {@link acquireService} needs to create the service when the verdict
 * says it should exist, plus the verdict itself.
 *
 * @typeParam T - The concrete Service subclass being reconciled. Inferred from `serviceType` so callers receive the specific subclass type back.
 *
 * @category Accessory
 */
export interface ValidServiceOptions<T extends Service = Service> extends AcquireServiceOptions<T> {

  /**
   * A boolean, or a predicate handed the service's current presence and answering whether it should exist. The predicate form is a synchronous
   * verdict only: it neither adds nor removes the service itself, and the presence it is handed is the presence {@link acquireService} then reads
   * when the verdict says the service should exist.
   */
  readonly validate: boolean | ((hasService: boolean) => boolean);
}

/**
 * The service {@link validService} answers, and the transition it performed to answer it: `"attached"` or `"kept"` pair a live service - the present arm
 * {@link AcquireServiceResult} already declares, reused here rather than restated - and `"removed"` or `"absent"` pair `null`, since neither transition
 * leaves a service behind to read. Reading `transition` narrows `service`: a check against `"attached"` or `"kept"` types it as `T`, and a check against
 * `"removed"` or `"absent"` types it as `null`.
 *
 * @category Accessory
 */
export type ValidServiceResult<T extends Service = Service> = AcquireServiceResult<T> |
  { readonly service: null; readonly transition: Exclude<PresenceTransition, "attached" | "kept"> };

/**
 * Reconciles a service's presence on the given accessory from one verdict: creates it through {@link acquireService} when the verdict says it should
 * exist and it does not, removes it when the verdict says it should not and it does, and leaves it alone otherwise.
 *
 * @typeParam T    - The concrete Service subclass being reconciled. Inferred from `serviceType` so callers receive the specific subclass type back.
 * @param options - The accessory, the service type, the display name and optional creation callback {@link acquireService} uses on a creating verdict,
 *                   an optional subtype, and the verdict that decides the service's presence. See {@link ValidServiceOptions}.
 *
 * @returns The service and the transition this call performed - `"attached"` or `"kept"` pair the service, `"removed"` or `"absent"` pair `null`. See
 * {@link ValidServiceResult}.
 *
 * @remarks
 * The `validate` parameter can be either:
 *   - a boolean (where `true` means the service should exist, `false` means remove it).
 *   - a function (which is called with `hasService: boolean` and returns whether the service should exist).
 *
 * A true verdict on an absent service is answered by {@link acquireService}, so creation exists in exactly one place in this module.
 *
 * @example
 * ```typescript
 * // Remove a service if it exists.
 * validService({ accessory, name: "Switch", serviceType: Service.Switch, validate: false });
 *
 * // Only keep a service if a configuration flag is true, creating it when the flag says it should exist.
 * validService({ accessory, name: "Switch", serviceType: Service.Switch, validate: config.enableSwitch });
 *
 * // Keep a service if it currently exists, or add it if a certain condition is met. A true verdict on an absent service creates it through
 * // acquireService, so `service` reads the live instance either way.
 * const { service } = validService({ accessory, name: "Switch", serviceType: Service.Switch,
 *   validate: (hasService) => hasService || config.enableSwitch });
 *
 * // `transition` narrows `service`: an "attached" or "kept" transition types it as the service, and a "removed" or "absent" transition types it as
 * // `null`.
 * const result = validService({ accessory, name: "Switch", serviceType: Service.Switch, validate: config.enableSwitch });
 *
 * if((result.transition === "attached") || (result.transition === "kept")) {
 *
 *   result.service.updateCharacteristic(Characteristic.On, false);
 * }
 * ```
 *
 * @see acquireService - the creation this function delegates to on a verdict that should exist.
 * @see validCharacteristic - the same contract, applied to one characteristic's presence on a service.
 * @category Accessory
 */
export function validService<T extends Service>({ accessory, name, onServiceCreate, serviceType, subtype, validate }: ValidServiceOptions<T>): ValidServiceResult<T> {

  const service = findService({ accessory, serviceType, subtype });

  // Resolve `validate` against the current presence and remove the service when the validator votes false. The function-form receives the actual presence boolean so
  // callers can express add-if-missing semantics like `(has) => has || config.enableSwitch`.
  if(!((typeof validate === "function") ? validate(!!service) : validate)) {

    if(service) {

      accessory.removeService(service);

      return { service: null, transition: "removed" };
    }

    return { service: null, transition: "absent" };
  }

  // A true verdict acquires the service, creation and all, so the family's only construction path stays acquireService's own. This costs a second
  // presence read on a true verdict, at accessory construction time, chosen over a second creation entry point.
  return acquireService({ accessory, name, onServiceCreate, serviceType, subtype });
}

/**
 * The transition a presence gate performed on one call: `attached` when the call put the characteristic on the service, `kept` when the service already carried
 * it and keeps it, `removed` when the service carried it and the verdict took it off, and `absent` when the service did not carry it and none was attached.
 * Presence afterward is `attached` or `kept`, so a consumer reads the presence and the transition that produced it from one answer.
 *
 * @category Accessory
 */
export type PresenceTransition = "absent" | "attached" | "kept" | "removed";

/**
 * The inputs {@link validCharacteristic} reconciles one characteristic's presence from: the characteristic itself, the service it lives on, and the verdict
 * that decides whether it should exist.
 *
 * @category Accessory
 */
export interface ValidCharacteristicOptions {

  /**
   * The characteristic whose presence on the service follows the verdict.
   */
  readonly characteristic: CharacteristicTarget;

  /**
   * The service the characteristic lives on.
   */
  readonly service: Service;

  /**
   * A boolean, or a predicate handed the characteristic's current presence and answering whether it should exist.
   */
  readonly validate: boolean | ((hasCharacteristic: boolean) => boolean);
}

/**
 * Validate whether a specific characteristic should exist on the given service, attaching it when it should and removing it when it should not.
 *
 * @param options - The characteristic, the service it lives on, and the verdict that decides its presence. See {@link ValidCharacteristicOptions}.
 *
 * @returns The transition the call performed - `"attached"`, `"kept"`, `"removed"`, or `"absent"`; the characteristic is present afterward when the answer
 * is `"attached"` or `"kept"`.
 *
 * @remarks
 * The `validate` parameter can be either:
 *   - a boolean (where `true` means the characteristic should exist, `false` means remove it).
 *   - a function (which is called with `hasCharacteristic: boolean` and returns whether the characteristic should exist).
 *
 * Presence is read without attaching, so a characteristic the service never carried is never materialized only to be removed. A true verdict attaches through
 * the service's own lookup, which adds an optional characteristic the service lacks and answers the existing one otherwise...the answer names which of the
 * four transitions happened, so a consumer that must act exactly once on the attach reads that from the answer. The helper is meant for a characteristic the
 * service declares optional. HAP attaches a characteristic outside a service's declared sets too, with a warning, and nothing here guards against that.
 *
 * @example
 * ```typescript
 * // Attach the characteristic while a configuration fact holds, and remove it otherwise.
 * validCharacteristic({ characteristic: Characteristic.StatusFault, service, validate: hasCredentials });
 *
 * // Keep the characteristic if the service already carries it, or add it when the user asks for it.
 * validCharacteristic({ characteristic: Characteristic.StatusTampered, service, validate: (has) => has || config.showTamper });
 *
 * // Gate the characteristic on a hardware capability and a user toggle.
 * validCharacteristic({ characteristic: Characteristic.StatusTampered, service,
 *   validate: capabilityGate({ capability: device.reportsTamper, toggle: config.tamperDetection }) });
 *
 * // Act exactly once when the characteristic first appears: write the verdict held for it.
 * if(validCharacteristic({ characteristic: Characteristic.StatusTampered, service, validate: tamperEnabled }) === "attached") {
 *
 *   service.updateCharacteristic(Characteristic.StatusTampered, heldTamperState);
 * }
 * ```
 *
 * @see validService - the same contract, applied to whether a service should exist on an accessory, its answer carrying the service alongside the transition.
 * @see capabilityGate - builds a predicate for either applier.
 * @category Accessory
 */
export function validCharacteristic({ characteristic, service, validate }: ValidCharacteristicOptions): PresenceTransition {

  // Read prior existence side-effect-free...getCharacteristic would attach the very characteristic the false branch is about to remove.
  const present = service.testCharacteristic(characteristic);

  // Resolve `validate` against the current presence and remove the characteristic when the validator votes false. The function form receives the actual presence
  // boolean so callers can express add-if-missing semantics like `(has) => has || config.showTamper`.
  if(!((typeof validate === "function") ? validate(present) : validate)) {

    if(present) {

      service.removeCharacteristic(service.getCharacteristic(characteristic));

      return "removed";
    }

    return "absent";
  }

  // One lookup is the whole of the additive half: it attaches an optional characteristic the service lacks and answers the one already there otherwise, and the
  // presence read above is what tells those two apart.
  service.getCharacteristic(characteristic);

  return present ? "kept" : "attached";
}

/**
 * Build a presence predicate for a service or a characteristic gated on a hardware capability and a user toggle, applying an additive-eager /
 * subtractive-conservative asymmetry between the two: the user `toggle` is absolute - when false, what it gates is removed - while the hardware `capability`
 * is conservative - an existing service is kept through a transient capability-false, and a missing one is added only when the capability reports.
 *
 * @param options - The `capability` and `toggle` inputs for the gate.
 *
 * @returns A function-form predicate for `validService` or `validCharacteristic`, `(present) => toggle && (present || capability)`.
 *
 * @remarks
 * Pass the result as the `validate` argument of `validService` or `validCharacteristic`. The asymmetry keeps a capability-gated service from being removed
 * during a transient window in which the device under-reports its capability, while still honoring a user who disables the service. A service with no user
 * toggle should gate on its capability directly.
 *
 * @example
 * ```typescript
 * // Keep the service while its user toggle is on, add it when the capability reports, and keep an existing one through a transient capability-false.
 * validService({ accessory, name: "Switch", serviceType: Service.Switch,
 *   validate: capabilityGate({ capability: deviceReportsFeature, toggle: config.enableSwitch }) });
 * ```
 *
 * @see validService - consumes the returned predicate.
 * @see validCharacteristic - consumes the returned predicate for one characteristic on a service.
 * @see updatePresenceCharacteristic - the same asymmetry, applied to one characteristic's presence on a service.
 * @category Accessory
 */
export function capabilityGate({ capability, toggle }: { capability: boolean; toggle: boolean }): (present: boolean) => boolean {

  return present => toggle && (present || capability);
}

/**
 * The reading a consumer's liveness policy maps its metric into, handed to {@link updatePresenceCharacteristic} on every pass: `reported` carries the value
 * HomeKit shows, `pending` means the metric is still reporting but has no number at this instant - the momentary gap between readings - and `absent` means the
 * metric has left liveness, having stopped reporting rather than merely gone quiet.
 *
 * @category Accessory
 */
export type PresenceReading = { state: "reported"; value: CharacteristicValue } | { state: "pending" } | { state: "absent" };

/**
 * The inputs {@link updatePresenceCharacteristic} reconciles one characteristic's presence from: the characteristic itself, the service it lives on, the
 * read-through behind it, and whether the device can currently be seen.
 *
 * @category Accessory
 */
export interface PresenceCharacteristicOptions {

  /**
   * The characteristic whose presence on the service follows the reading behind it.
   */
  readonly characteristic: CharacteristicTarget;

  /**
   * Whether the device can currently be seen. A removal is believed only when it can, so a device that has dropped off keeps every characteristic it had.
   */
  readonly reachable: boolean;

  /**
   * The read-through behind the characteristic, called on every pass and on every HomeKit pull so the bound handler answers from the record at pull time rather
   * than from whatever was true when it was bound.
   */
  readonly read: () => PresenceReading;

  /**
   * The service the characteristic lives on.
   */
  readonly service: Service;
}

/**
 * Reconcile one characteristic's presence on a service against the reading behind it, applying the same additive-eager / subtractive-conservative asymmetry
 * {@link capabilityGate} applies to services, one level down.
 *
 * @param options - The characteristic, its service, the read-through behind it, and the device's reachability. See {@link PresenceCharacteristicOptions}.
 *
 * @remarks
 * Every outcome follows from one read of the reading. ADD or UPDATE: a reported reading attaches the characteristic and writes the value it carries, with no
 * reachability gate on this half, because the guarantee is asymmetric - the characteristic set never shrinks outside a real loss of the metric, while growth is
 * welcome the moment data arrives. HOLD: a pending reading, or a device that cannot be seen, writes nothing and removes nothing, so a momentary gap between
 * readings or an offline window leaves HomeKit showing the last thing the sensor said. REMOVE: an absent reading on a reachable device takes the characteristic
 * away, the one case in which the metric genuinely stopped reporting rather than merely going quiet.
 *
 * The read-through is bound on every reported pass rather than only where the characteristic is attached. A characteristic restored from the accessory cache, or
 * re-attached by HAP after a removal, is a fresh object carrying no handler and answering its own cached value, and HAP replaces a bound handler rather than
 * stacking one, so rebinding every pass is what keeps a pull honest and costs nothing.
 *
 * @example
 * ```typescript
 * // Follow one metric's liveness, mapping the sensor's own metric into a reading.
 * updatePresenceCharacteristic({ characteristic: Characteristic.PM2_5Density, reachable: this.isReachable, read: () => toReading(this.metric), service });
 * ```
 *
 * @see capabilityGate - the same asymmetry, applied to whether a service should exist at all.
 * @category Accessory
 */
export function updatePresenceCharacteristic({ characteristic, reachable, read, service }: PresenceCharacteristicOptions): void {

  const reading = read();

  if(reading.state === "reported") {

    // Answer a pull from the record rather than from the pass that bound this handler...a pull arriving between readings answers what HomeKit already holds
    // rather than a dead reading.
    service.getCharacteristic(characteristic).onGet(() => {

      const current = read();

      return (current.state === "reported") ? current.value : service.getCharacteristic(characteristic).value;
    });

    service.updateCharacteristic(characteristic, reading.value);

    return;
  }

  // A metric that is still reporting, or a device we cannot currently see, holds whatever HomeKit has.
  if((reading.state === "pending") || !reachable) {

    return;
  }

  // Read prior existence side-effect-free...getCharacteristic would attach the very characteristic this branch is about to remove.
  if(service.testCharacteristic(characteristic)) {

    service.removeCharacteristic(service.getCharacteristic(characteristic));
  }
}

/**
 * Write one characteristic value to every service on an accessory that carries that characteristic, leaving every other service untouched.
 *
 * @param accessory      - The Homebridge accessory whose services are swept.
 * @param characteristic - The characteristic to write, matched against each service by the class's static UUID.
 * @param value          - The value written to every service that carries the characteristic.
 *
 * @remarks
 * A device-wide state - reachability, tamper, an availability flag - belongs on several of an accessory's services at once, and which services those are depends on
 * what the device turned out to support. Selecting by the characteristic rather than by a roster of service types is what keeps that correct without anyone
 * maintaining the roster: a service added later is swept the moment it carries the characteristic, and a service that never carries it is never written to. The
 * test is also what keeps the sweep from creating anything, because HAP's `updateCharacteristic` attaches a characteristic the service is missing - an unguarded walk
 * would dress every service on the accessory instead of the ones that model the state.
 *
 * The AccessoryInformation service needs no exception of its own. It carries none of the state characteristics a caller sweeps, so the same test passes over it.
 *
 * @example
 * ```typescript
 * // Project a device-wide reachability state onto every service that models it.
 * updateServices(accessory, hap.Characteristic.StatusActive, isReachable);
 * ```
 *
 * @category Accessory
 */
export function updateServices(accessory: PlatformAccessory, characteristic: CharacteristicTarget, value: CharacteristicValue): void {

  for(const service of accessory.services) {

    if(service.testCharacteristic(characteristic)) {

      service.updateCharacteristic(characteristic, value);
    }
  }
}

/**
 * The answer HAP's set handler contract carries, and the bound {@link notResponding} holds a wrapped handler's answer to: a nullable characteristic value or
 * nothing, answered directly or through a promise. It contains every answer a get handler may give, so it is the one bound that admits every handler HAP defines,
 * and it is read from HAP's own type so HAP stays the source of truth for it.
 *
 * @category Accessory
 */
export type CharacteristicHandlerAnswer = ReturnType<CharacteristicSetHandler>;

/**
 * The facts about a device that {@link notResponding} binds once: the class a refusal is constructed from, the status it carries, and the predicate it reads.
 *
 * @category Accessory
 */
export interface NotRespondingOptions {

  /**
   * The plugin's `api.hap.HapStatusError`, typed by its constructor shape so a plugin's own status-error double fits it as readily as the HAP class does. The type
   * describes the constructor and not what it does with what it is handed, so a class that ignores the status satisfies it too...the tests assert the status a
   * refusal carries rather than only the class it is an instance of.
   */
  readonly errorClass: new (status: HAPStatus) => Error;

  /**
   * The HAP status a refusal carries. Defaults to `HAPStatus.SERVICE_COMMUNICATION_FAILURE`, the status HomeKit renders as Not Responding, so a consumer names
   * one only when it means a different status.
   */
  readonly status?: HAPStatus;

  /**
   * The plugin's own availability composition, answering `true` while the device cannot be reached. It is read on each wrapped call rather than captured when the
   * wrapper is built: a device that goes offline refuses the very next call, and one that comes back answers it.
   */
  readonly unavailable: () => boolean;
}

/**
 * Binds a device's Not Responding rule once and returns a wrapper that makes any characteristic handler refuse a read or a write while the device is unavailable.
 *
 * @param options - The error class, the status, and the availability predicate every wrapped call consults. See {@link NotRespondingOptions}.
 *
 * @returns A wrapper that takes any characteristic handler HAP defines - a get handler or a set handler, synchronous or asynchronous - and returns a handler of the
 *          same shape, throwing while `unavailable()` is true and passing every argument through to the wrapped handler otherwise.
 *
 * @remarks
 * HomeKit renders a get handler that throws a HAP status error as Not Responding and a set handler that throws one as a failed write, because HAP's set-request
 * path catches a `HapStatusError` and surfaces its status as the write's result. Whatever a handler answers or accepts, HomeKit renders as fact, so a characteristic
 * wired around this rule answers a stale value, or accepts a write it cannot deliver, while its device cannot be reached, which is the dishonest display the rule
 * exists to avoid...wiring every characteristic handler through the wrapper leaves exactly one place that decides whether the device can answer at all.
 *
 * The wrapper refuses before the handler runs, so a write never reaches a device that cannot be reached and a read never answers a stale value. The refusal is a
 * synchronous throw for an asynchronous handler too, since the wrapper decides before it calls, and HAP catches a synchronous throw and a rejection alike. While the
 * device is available, every argument passes through to the handler unchanged and the handler's answer comes back as it gave it.
 *
 * The error class is injected rather than imported because this library holds `homebridge` and `@homebridge/hap-nodejs` as development dependencies alone and
 * carries no HAP dependency at runtime: `HapStatusError` reaches a plugin as a member of the runtime `api.hap` namespace, and the plugin is the only holder of it.
 * The class, the status, and the predicate are facts about a device, while a handler is a fact about one characteristic, so the two bind at different moments - the
 * device binds the rule once, then wraps each handler as it wires it.
 *
 * @example
 * ```typescript
 * // Bind the rule once, where the device composes its own availability.
 * this.answering = notResponding({ errorClass: api.hap.HapStatusError, unavailable: () => this.offline || this.unreachable });
 *
 * // Wire a characteristic's reads through it. The get handler answers while the device is reachable, and never runs while it is not.
 * service.getCharacteristic(Characteristic.On).onGet(this.answering(() => this.active));
 *
 * // Wire its writes through the same binding. The set handler runs while the device is reachable, and the write fails while it is not.
 * service.getCharacteristic(Characteristic.On).onSet(this.answering((value) => this.setActive(value)));
 * ```
 *
 * @see capabilityGate - the same bind-once shape, applied to whether a service should exist at all.
 * @category Accessory
 */
export function notResponding({ errorClass, status = HAPStatus.SERVICE_COMMUNICATION_FAILURE, unavailable }: NotRespondingOptions):
<A extends unknown[], T extends CharacteristicHandlerAnswer>(handler: (...args: A) => T) => (...args: A) => T {

  return <A extends unknown[], T extends CharacteristicHandlerAnswer>(handler: (...args: A) => T): (...args: A) => T => {

    return (...args: A): T => {

      // Availability is read here, on each call, rather than once in the factory. A device's availability changes between the wiring of a handler and any later
      // call to it, and consulting the predicate fresh is what lets a recovery clear a refusal, and a loss of contact raise one, without rewiring anything.
      if(unavailable()) {

        throw new errorClass(status);
      }

      return handler(...args);
    };
  };
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

  // ConfiguredName and Name are HAP string-typed characteristics by definition, which is what makes the narrowing below sound despite the wider
  // `CharacteristicValue` union the reads are declared against.
  return (configuredName ?? name ?? undefined) as string | undefined;
}

/**
 * Updates the display name of an accessory and of its AccessoryInformation service to the specified value.
 *
 * @param accessory - The accessory to rename.
 * @param name      - The new name to apply to the accessory.
 *
 * @remarks
 * An accessory carries its name in more than one place, and a rename that reaches only some of them leaves the accessory answering to two names. This writes all
 * of them from one sanitized source, then hands each pair to whichever API owns it: Homebridge's `updateDisplayName` owns the accessory display names (the
 * `PlatformAccessory`'s own and the HAP accessory's beneath it), and {@link setServiceName} owns the AccessoryInformation service's `ConfiguredName` and `Name`
 * characteristics. `ConfiguredName` is what makes a rename stick in the Home app, since it is the name a user can edit there.
 *
 * The name is sanitized through the same HomeKit naming rules {@link acquireService} applies, so a caller may pass a raw device name straight through. A name with
 * nothing left after sanitizing is not applied anywhere: an accessory has to answer to something, and a blank one is worse than the name it already had.
 *
 * @example
 * ```typescript
 * // Rename an accessory after the device reports a new name.
 * setAccessoryName(accessory, device.name);
 * ```
 *
 * @see setServiceName - the per-service equivalent this delegates its characteristic writes to.
 * @see getServiceName - to retrieve the current name set on a service.
 * @category Accessory
 */
export function setAccessoryName(accessory: PlatformAccessory, name: string): void {

  // Sanitize once. HomeKit's naming rules govern the accessory display names and the information service's name characteristics alike, so one validation pass
  // feeds every write below and none of them can disagree about what the name is. Nothing surviving the sanitize means there is no name to apply, and a partial
  // rename that blanked the information service while leaving the display names alone would be worse than doing nothing.
  const sanitized = sanitizeName(name);

  if(!sanitized.length) {

    return;
  }

  // Hand the accessory display names to Homebridge's own setter, which writes the platform wrapper's `displayName` and the HAP accessory's together. Going through
  // the documented API rather than assigning the two fields directly keeps this off Homebridge's internal `_associatedHAPAccessory` handle entirely.
  accessory.updateDisplayName(sanitized);

  const [first] = accessory.services;

  if(!first) {

    return;
  }

  // Reach AccessoryInformation through the same constructor reflection the UUID sets use: HAP's static service registry is not reachable from this module, but
  // every service instance carries a constructor that holds it. Delegating the write to setServiceName rather than setting the characteristics here keeps the
  // ConfiguredName / Name conditional logic in its single home.
  const serviceType = first.constructor as unknown as { AccessoryInformation?: { UUID: string } };
  const informationService = accessory.services.find((service) => service.UUID === serviceType.AccessoryInformation?.UUID);

  if(informationService) {

    setServiceName(informationService, sanitized);
  }
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
 * @see setAccessoryName - the accessory-level equivalent, which delegates its information-service write here.
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
