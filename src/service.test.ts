/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * service.test.ts: Unit tests for the HomeKit service helper utilities in service.ts.
 *
 * The fixture side uses real `@homebridge/hap-nodejs` primitives (Accessory, Service, Characteristic), declared as an explicit devDependency so the test-side
 * Accessory/Service/Characteristic identities match the same HAP package `homebridge` re-exports from its public type surface. The methods we exercise on the
 * hand-constructed `Accessory` are the exact API surface `PlatformAccessory` delegates to at runtime - using the real runtime objects keeps the tests honest against
 * `service.ts`'s reflection-driven characteristic lookup; a hand-rolled mock would force us to replicate the HAP characteristic-constructor map, which is precisely
 * the thing we want to exercise.
 */
import * as hap from "@homebridge/hap-nodejs";
import type { Characteristic, CharacteristicValue, PlatformAccessory, Service, WithUUID } from "homebridge";
import type { PresenceReading, ValidCharacteristicOptions } from "./service.ts";
import { acquireService, capabilityGate, getServiceName, notResponding, setAccessoryName, setServiceName, updatePresenceCharacteristic, updateServices,
  validCharacteristic, validService } from "./service.ts";
import { describe, test } from "node:test";
import { HAPStatus } from "./homebridge-enums.ts";
import type { Nullable } from "./util.ts";
import assert from "node:assert/strict";

// The HAP static-Characteristic shape: every Characteristic class ships with a `UUID` static and satisfies `new () => Characteristic`. That is the exact type HAP's
// `service.updateCharacteristic` accepts and the type whose `UUID` powers identity-matching against `service.characteristics` / `service.optionalCharacteristics`.
type CharacteristicCtor = WithUUID<new () => Characteristic>;

// The two HAP name slots this test file distinguishes. Kept narrow so the reflection helper cannot be called with an arbitrary string and silently return undefined
// for a real-world slot that simply happens not to match the map. Adding more slots is a one-line change if future behavior requires it.
type NamedCharacteristicSlot = "ConfiguredName" | "Name";

// Construct a bare hap-nodejs accessory and cast to PlatformAccessory. PlatformAccessory is a thin wrapper around Accessory whose service-management methods
// (getService, addService, removeService, getServiceById) delegate directly to the underlying HAP instance. For the surfaces this module exercises, the real HAP
// accessory is indistinguishable from PlatformAccessory and keeps the test honest against real HAP internals.
function makeAccessory(): PlatformAccessory {

  return new hap.Accessory("TestAccessory", hap.uuid.generate("homebridge-plugin-utils.service-test.accessory")) as unknown as PlatformAccessory;
}

/* Construct a PlatformAccessory-shaped wrapper over a real HAP accessory, wired the way Homebridge's own constructor wires it: `_associatedHAPAccessory` is the HAP
 * instance, `displayName` is a plain copy of its display name (not a live view of it), and `services` is the HAP accessory's own array by reference. makeAccessory
 * above is enough for the service-level helpers, but setAccessoryName renames the accessory itself, and only a fixture carrying both display names can tell a
 * complete rename apart from one that reached the wrapper and stopped there.
 *
 * `updateDisplayName` is transcribed from Homebridge's implementation rather than inherited from it, because the `homebridge` package exposes PlatformAccessory as
 * a type only - its runtime exports are the HAP re-exports - so the class cannot be constructed here. The transcription is the whole of that method: a truthy name
 * writes both display names, a falsy one writes neither. If Homebridge's version ever diverges, this is where the divergence has to be reflected.
 */
function makePlatformAccessory(): { accessory: PlatformAccessory; hapAccessory: hap.Accessory } {

  const hapAccessory = new hap.Accessory("TestAccessory", hap.uuid.generate("homebridge-plugin-utils.service-test.platform-accessory"));

  const accessory = {

    _associatedHAPAccessory: hapAccessory,
    displayName: hapAccessory.displayName,
    services: hapAccessory.services,

    updateDisplayName(name: string): void {

      if(name) {

        accessory.displayName = name;
        hapAccessory.displayName = name;
      }
    }
  } as unknown as PlatformAccessory;

  return { accessory, hapAccessory };
}

// The AccessoryInformation service every HAP accessory is constructed with. Looked up by the constructor's own static UUID rather than by index, so the helper does
// not depend on where HAP happens to place it in the services array.
function informationServiceOf(accessory: PlatformAccessory): Service {

  const service = accessory.services.find((candidate) => candidate.UUID === hap.Service.AccessoryInformation.UUID);

  if(!service) {

    throw new Error("The fixture accessory has no AccessoryInformation service.");
  }

  return service;
}

/* The presence fixture: a real HAP AirQualitySensor service, a mutable reading behind the read-through, and counters for the service-level events the rows
 * read their outcomes from. The counts are the observers because HAP raises `characteristic-change` on every write, an unchanged value included, so a zero delta
 * is what proves a hold wrote nothing - the value HomeKit holds cannot tell a hold apart from a write of the same number. `service-configurationChange` answers
 * an attach and a detach alike, so an unchanged count is what proves a pass that removed nothing also attached nothing.
 */
function presenceFixture(): { changes: () => number; configurations: () => number; pass: (reachable: boolean) => void;
  reading: (next: PresenceReading) => void; service: Service; } {

  const { hapAccessory } = makePlatformAccessory();
  const service = hapAccessory.addService(hap.Service.AirQualitySensor, "Air");
  const holder: { reading: PresenceReading } = { reading: { state: "absent" } };
  let changes = 0;
  let configurations = 0;

  service.on("characteristic-change", () => {

    changes++;
  });

  service.on("service-configurationChange", () => {

    configurations++;
  });

  return {

    changes: (): number => changes,
    configurations: (): number => configurations,
    pass: (reachable: boolean): void => updatePresenceCharacteristic({ characteristic: hap.Characteristic.PM2_5Density, reachable,
      read: () => holder.reading, service }),
    reading: (next: PresenceReading): void => {

      holder.reading = next;
    },
    service
  };
}

/* The gate fixture: a real HAP MotionSensor service, which declares `StatusTampered` optional, and a counter for the service-level events the rows read their
 * outcomes from. The count is the observer because the service raises `service-configurationChange` on an attach and on a detach alike, so a zero delta is what
 * proves a pass materialized nothing - `testCharacteristic` answers only what the service carries at the moment it is asked, and cannot tell a characteristic
 * that was never attached from one attached and taken away again.
 */
function gateFixture(): { configurations: () => number; gate: (validate: boolean | ((hasCharacteristic: boolean) => boolean)) => boolean; service: Service } {

  const { hapAccessory } = makePlatformAccessory();
  const service = hapAccessory.addService(hap.Service.MotionSensor, "Motion");
  let configurations = 0;

  service.on("service-configurationChange", () => {

    configurations++;
  });

  return {

    configurations: (): number => configurations,
    gate: (validate: boolean | ((hasCharacteristic: boolean) => boolean)): boolean => {

      return validCharacteristic({ characteristic: hap.Characteristic.StatusTampered, service, validate });
    },
    service
  };
}

// Single source of truth for HAP's reflection-based characteristic discovery. Every HAP `Service` instance carries a `characteristics` array whose elements share a
// constructor. That constructor is the `Characteristic` class, which exposes each well-known characteristic as a static property (e.g., `Characteristic.ConfiguredName`)
// typed as `WithUUID<new () => Characteristic>`. `service.ts` relies on exactly this pattern at runtime - see its `getCharacteristicConstructor` helper - and every test
// helper in this file composes on top of `resolveCharacteristic` so the one cast that bridges the reflection gap lives in exactly one place.
function resolveCharacteristic(service: Service, slot: NamedCharacteristicSlot): CharacteristicCtor | undefined {

  const [first] = service.characteristics;

  if(!first) {

    return undefined;
  }

  const catalog = first.constructor as unknown as Record<string, CharacteristicCtor | undefined>;

  return catalog[slot];
}

// Return the value currently stored on the named characteristic, or `undefined` when the characteristic is not attached to the service. Deliberately avoids HAP's
// `service.getCharacteristic()` because that method lazy-adds a missing characteristic on read, which would mask the exact behavior this test file exists to verify
// (acquireService's decision to skip ConfiguredName on services that do not support it). Reading directly from `service.characteristics` gives a true "is this present
// right now" snapshot.
function readNamedCharacteristic(service: Service, slot: NamedCharacteristicSlot): string | undefined {

  const target = resolveCharacteristic(service, slot);

  if(!target) {

    return undefined;
  }

  return (service.characteristics.find((c) => c.UUID === target.UUID)?.value ?? undefined) as string | undefined;
}

// Return whether the service's optional characteristics catalog advertises the named slot. acquireService's contract is to add ConfiguredName / Name to the optional
// list when the service type supports them and they are not already there; this helper gives the test a direct read of that catalog.
function optionalIncludes(service: Service, slot: NamedCharacteristicSlot): boolean {

  const target = resolveCharacteristic(service, slot);

  return target ? service.optionalCharacteristics.some((c) => c.UUID === target.UUID) : false;
}

// Count the number of entries in the optional catalog matching the named slot. Equivalent to `optionalIncludes` with numeric precision - the non-duplication test uses
// this to assert exactly one entry after repeated acquisitions, which is strictly stronger than a boolean presence check.
function optionalCount(service: Service, slot: NamedCharacteristicSlot): number {

  const target = resolveCharacteristic(service, slot);

  return target ? service.optionalCharacteristics.filter((c) => c.UUID === target.UUID).length : 0;
}

/* The status-error class the notResponding tests inject, standing in for a plugin's `api.hap.HapStatusError`: an Error subclass carrying the numeric status it was
 * constructed with, which is what a refusal is read for. Declared here rather than imported so the suite keeps the same posture the module under test has - no
 * runtime edge to HAP for a class the library never imports - and so the injected shape is exactly the shape a plugin's own double has.
 */
class StatusError extends Error {

  public readonly hapStatus: number;

  public constructor(status: number) {

    super("HAP Status Error: " + status.toString());

    this.hapStatus = status;
    this.name = "HapStatusError";
  }
}

/* Compile-time shape exercises for the reader type notResponding accepts. These never run - the function is never called, and its leading underscore marks it, with
 * its bindings, as a compile-time exercise the typecheck reads - so they add nothing to the runtime totals; TypeScript still type-checks the body during
 * `npm run typecheck`, so a shape regression fails the build here rather than silently at a consuming plugin. The negative case uses `@ts-expect-error`, which fails
 * the build if the error it expects ever stops occurring.
 */
const _readerShapeExercises = (): void => {

  const wrap = notResponding({ errorClass: StatusError, unavailable: () => false });

  // A reader of each primitive HomeKit carries is accepted, and each answers a reader of its own type back rather than a widened one.
  const _number: () => number = wrap((): number => 42);
  const _string: () => string = wrap((): string => "Stopped");
  const _boolean: () => boolean = wrap((): boolean => true);

  // HAP's own get handler may answer null, so a reader that does is accepted here too. Each line exercises the bound from a different end: one reader narrowed to
  // a single nullable primitive, and one answering the whole HAP value union the bound itself names.
  const _nullable: () => number | null = wrap((): number | null => null);
  const _value: () => Nullable<CharacteristicValue> = wrap((): Nullable<CharacteristicValue> => null);

  // @ts-expect-error - a symbol is not a CharacteristicValue, so a reader answering one is not a characteristic reader.
  const _symbol = wrap((): symbol => Symbol("not a characteristic value"));
};

/* Compile-time shape exercises for the reading a consumer's liveness policy maps its metric into. These never run - the function is never called, and its leading
 * underscore marks it, with its bindings, as a compile-time exercise the typecheck reads - so they add nothing to the runtime totals. The negative cases use
 * `@ts-expect-error`, which fails the build if the error each expects ever stops occurring.
 */
const _presenceReadingShapeExercises = (): void => {

  // Each state is assignable from a literal of its own shape, and the value HomeKit shows is carried by the reported state alone.
  const _reported: PresenceReading = { state: "reported", value: 42 };
  const _pending: PresenceReading = { state: "pending" };
  const _absent: PresenceReading = { state: "absent" };

  // @ts-expect-error - a reported reading with no value is not a reading at all, since carrying the value is what the reported state exists to do.
  const _valueless: PresenceReading = { state: "reported" };

  // @ts-expect-error - a symbol is not a CharacteristicValue, so no reading can carry one.
  const _symbolValued: PresenceReading = { state: "reported", value: Symbol("not a characteristic value") };
};

/* Compile-time shape exercises for the options {@link validCharacteristic} reads a characteristic's fate from. These never run - the function is never called,
 * and its leading underscore marks it, with its bindings, as a compile-time exercise the typecheck reads - so they add nothing to the runtime totals. The
 * negative cases use `@ts-expect-error`, which fails the build if the error each expects ever stops occurring.
 */
const _validCharacteristicShapeExercises = (): void => {

  const { service } = gateFixture();

  // Both verdict forms are accepted: a plain boolean, and a predicate handed the presence the applier read.
  const _booleanVerdict: ValidCharacteristicOptions = { characteristic: hap.Characteristic.StatusTampered, service, validate: true };
  const _predicateVerdict: ValidCharacteristicOptions = { characteristic: hap.Characteristic.StatusTampered, service, validate: (has) => has };

  // @ts-expect-error - the verdict is required, because there is nothing else for the characteristic's presence to follow.
  const _verdictless: ValidCharacteristicOptions = { characteristic: hap.Characteristic.StatusTampered, service };

  // @ts-expect-error - a string is neither a boolean nor a presence predicate, so it cannot stand in for the verdict.
  const _stringVerdict: ValidCharacteristicOptions = { characteristic: hap.Characteristic.StatusTampered, service, validate: "yes" };
};

describe("acquireService - creation path", () => {

  test("creates the service, adds it to the accessory, and invokes onServiceCreate exactly once", () => {

    const accessory = makeAccessory();
    let invocations = 0;
    const service = acquireService(accessory, hap.Service.Switch, "Patio Switch", undefined, () => {

      invocations++;
    });

    assert.ok(service, "acquireService must return the created service");
    assert.equal(invocations, 1, "onServiceCreate must fire exactly once on the creation path");
    assert.equal(accessory.getService(hap.Service.Switch), service, "created service must be reachable via getService");
  });

  test("sanitizes the incoming name before applying it to the service", () => {

    // "Patio|Switch" contains a disallowed character that sanitizeName replaces with a space. The displayName and the ConfiguredName / Name characteristic values should
    // all carry the sanitized form, not the raw input. This is service.ts's documented contract: HomeKit-safe naming at every surface.
    const accessory = makeAccessory();
    const service = acquireService(accessory, hap.Service.Switch, "Patio|Switch");

    assert.ok(service, "acquireService must return the created service");
    assert.equal(service.displayName, "Patio Switch");
    assert.equal(readNamedCharacteristic(service, "ConfiguredName"), "Patio Switch");
    assert.equal(readNamedCharacteristic(service, "Name"), "Patio Switch");
  });

  test("returns the existing service on subsequent calls without invoking the create callback", () => {

    // Get-or-create semantics: the second call must find the service from the first call and return it unchanged. The creation callback must not fire a second time,
    // which is the "newly created services only" guarantee acquireService documents.
    const accessory = makeAccessory();
    let invocations = 0;
    const first = acquireService(accessory, hap.Service.Switch, "Switch A", undefined, () => { invocations++; });
    const second = acquireService(accessory, hap.Service.Switch, "Switch B", undefined, () => { invocations++; });

    assert.equal(first, second, "second acquisition must return the same service instance");
    assert.equal(invocations, 1, "onServiceCreate must not fire on the get path");
  });
});

describe("acquireService - subtype handling", () => {

  test("creates distinct services keyed by subtype", () => {

    // Two acquisitions with different subtypes must produce two different service instances, each reachable via getServiceById. This validates the "uniquely identify
    // the service" subtype contract at both ends: the lookup side and the creation side.
    const accessory = makeAccessory();
    const alpha = acquireService(accessory, hap.Service.Switch, "Alpha", "sub-alpha");
    const beta = acquireService(accessory, hap.Service.Switch, "Beta", "sub-beta");

    assert.ok(alpha, "first subtype acquisition must return its service");
    assert.ok(beta, "second subtype acquisition must return its service");
    assert.notEqual(alpha, beta, "distinct subtypes must produce distinct service instances");
    assert.equal(accessory.getServiceById(hap.Service.Switch, "sub-alpha"), alpha);
    assert.equal(accessory.getServiceById(hap.Service.Switch, "sub-beta"), beta);
  });

  test("returns the existing subtype-keyed service on re-acquisition", () => {

    const accessory = makeAccessory();
    const first = acquireService(accessory, hap.Service.Switch, "Alpha", "sub-alpha");
    const second = acquireService(accessory, hap.Service.Switch, "Alpha 2", "sub-alpha");

    assert.equal(first, second, "re-acquisition with the same subtype must return the same instance");
  });
});

describe("acquireService - name characteristic management", () => {

  test("does not add a ConfiguredName when the service type neither requires nor supports it", () => {

    // The Fan service is in the `hasName` catalog but not in the `hasConfiguredName` catalog, so acquireService must write a Name but leave ConfiguredName absent from
    // both the live characteristics array and the optional catalog. Exercises the `!serviceHasConfiguredName` early-exit branch in the add-optional-characteristic
    // block. Using `readNamedCharacteristic` (direct array scan) is deliberate - HAP's getCharacteristic() would lazily add the missing characteristic and corrupt the
    // signal we want to measure.
    const accessory = makeAccessory();
    const service = acquireService(accessory, hap.Service.Fan, "Room Fan");

    assert.ok(service, "acquireService(Fan) must succeed before we inspect characteristic management");
    assert.equal(readNamedCharacteristic(service, "Name"), "Room Fan", "Name must be set on a service that supports it");
    assert.equal(readNamedCharacteristic(service, "ConfiguredName"), undefined, "ConfiguredName must not be present on a service type that does not support it");
    assert.equal(optionalIncludes(service, "ConfiguredName"), false, "ConfiguredName must not appear in the optional catalog either");
  });

  test("sets both ConfiguredName and Name on a service that supports both", () => {

    const accessory = makeAccessory();
    const service = acquireService(accessory, hap.Service.Switch, "Kitchen Switch");

    assert.ok(service, "acquireService(Switch) must succeed before we inspect characteristic management");
    assert.equal(readNamedCharacteristic(service, "ConfiguredName"), "Kitchen Switch");
    assert.equal(readNamedCharacteristic(service, "Name"), "Kitchen Switch");
    assert.equal(optionalIncludes(service, "ConfiguredName"), true, "ConfiguredName must be listed among the optional characteristics after acquisition");
  });

  test("sets ConfiguredName on a StatelessProgrammableSwitch so a grouped remote button carries a HomeKit-honored name", () => {

    // A StatelessProgrammableSwitch grouped under a ServiceLabel is labeled by the Home app from its ServiceLabelIndex ("Button 1", "Button 2", ...) unless it carries a
    // ConfiguredName, which the Home app honors as the button's name. StatelessProgrammableSwitch is in the hasConfiguredName catalog for exactly this reason, so a
    // multi-button remote (a fob, a scene controller) surfaces its button names rather than generic numeric indices.
    const accessory = makeAccessory();
    const service = acquireService(accessory, hap.Service.StatelessProgrammableSwitch, "Panic");

    assert.ok(service, "acquireService(StatelessProgrammableSwitch) must succeed before we inspect characteristic management");
    assert.equal(readNamedCharacteristic(service, "ConfiguredName"), "Panic", "the Home app shows the ConfiguredName instead of the ServiceLabelIndex label");
    assert.equal(readNamedCharacteristic(service, "Name"), "Panic");
    assert.equal(optionalIncludes(service, "ConfiguredName"), true, "ConfiguredName must be listed among the optional characteristics after acquisition");
  });

  test("does not re-add ConfiguredName to the optional catalog when already present", () => {

    // Re-acquiring the same service must hit the get-path, not the create-path, so the add-optional-characteristic branches do not run a second time. We prove that
    // by asserting the optional catalog carries exactly one ConfiguredName entry after two acquisitions - a duplicated add would surface as `count === 2`.
    const accessory = makeAccessory();
    const first = acquireService(accessory, hap.Service.Switch, "One");

    assert.ok(first, "first acquisition must return a service before we re-acquire");

    acquireService(accessory, hap.Service.Switch, "Two");

    assert.equal(optionalCount(first, "ConfiguredName"), 1, "ConfiguredName must appear exactly once on the optional catalog across repeated acquisitions");
  });

  test("adds Name to the optional catalog when the service supports Name but does not include it by default", () => {

    // Coverage for the Name-add branch in acquireService (the `serviceHasName` top-up). Most HAP services include Name in their default optionalCharacteristics, so
    // the branch's body rarely fires in real usage. We trigger it deliberately by subclassing a HAP service whose UUID is in `hasNameUUIDs` (Switch) and removing
    // Name from its optional catalog before acquireService inspects it. The function must then call addOptionalCharacteristic(Name) and the optional catalog must
    // carry Name afterwards.
    class SwitchWithoutNameOptional extends hap.Service.Switch {

      constructor(displayName?: string, subtype?: string) {

        super(displayName, subtype);

        // Strip Name out of the optional catalog so the add-Name branch in acquireService has work to do.
        const cast = this.optionalCharacteristics as { UUID: string }[];
        const nameUuid = hap.Characteristic.Name.UUID;
        const filtered = cast.filter((c) => c.UUID !== nameUuid);

        cast.length = 0;
        cast.push(...filtered);
      }
    }

    const accessory = makeAccessory();
    const ctor = SwitchWithoutNameOptional;
    const service = acquireService(accessory, ctor, "Sentinel Switch");

    assert.ok(service, "acquireService must return the constructed service");
    assert.equal(optionalIncludes(service, "Name"), true, "acquireService must add Name to the optional catalog when the service supports Name but lacks it by default");
  });

  test("throws when the constructed service has no characteristics (defensive guard)", () => {

    // Coverage for acquireService's defensive `if(!first)` throw (`new Error("Service has no characteristics; ...")`) in service.ts. Real HAP services always
    // construct with at least one required characteristic, so this branch never fires under normal usage; the guard exists because `noUncheckedIndexedAccess`
    // requires a defensive check on `service.characteristics[0]` and the explicit throw makes the unreachability assumption surface loudly if ever violated. We
    // exercise it by subclassing a HAP service and forcibly clearing its characteristics array before acquireService inspects it.
    class CharacteristicLessSwitch extends hap.Service.Switch {

      constructor(displayName?: string, subtype?: string) {

        super(displayName, subtype);

        // Force an empty characteristics array so the getCharacteristicConstructor's defensive check fires. The cast through unknown sidesteps HAP's `readonly` typing
        // on the array - the field is mutable at runtime, but the type annotates it as a get-only view.
        (this as unknown as { characteristics: unknown[] }).characteristics = [];
      }
    }

    const accessory = makeAccessory();
    const ctor = CharacteristicLessSwitch;

    assert.throws(() => acquireService(accessory, ctor, "broken"), { message: /Service has no characteristics/ },
      "the defensive guard must throw with the documented message when a service arrives without characteristics");
  });
});

describe("validService", () => {

  test("returns true and keeps the service when `validate` is true", () => {

    const accessory = makeAccessory();
    const service = acquireService(accessory, hap.Service.Switch, "Keep Me");

    assert.ok(service, "the service must exist before validService verifies its retention contract");
    assert.equal(validService(accessory, hap.Service.Switch, true), true);
    assert.ok(accessory.getService(hap.Service.Switch), "service must remain on the accessory");
  });

  test("returns false and removes the service when `validate` is false", () => {

    // Boolean-false path: the service exists on the accessory, validation rejects it, the service is removed. `getService` must report absence afterwards.
    const accessory = makeAccessory();

    acquireService(accessory, hap.Service.Switch, "Remove Me");

    assert.equal(validService(accessory, hap.Service.Switch, false), false);
    assert.equal(accessory.getService(hap.Service.Switch), undefined, "service must be removed from the accessory");
  });

  test("returns false without error when the service does not exist and `validate` is false", () => {

    // No service to remove; the function short-circuits cleanly. This is the typical "clean up a feature the user disabled" case when the feature was never enabled.
    const accessory = makeAccessory();

    assert.equal(validService(accessory, hap.Service.Switch, false), false);
  });

  test("callback form receives the current existence state", () => {

    // The callback-form `validate` signature is `(hasService) => boolean`. We assert both branches: when the service already exists the boolean is true, and when it
    // does not the boolean is false. Returning the boolean verbatim keeps the service's state unchanged in each case.
    const accessory = makeAccessory();

    acquireService(accessory, hap.Service.Switch, "Present");

    let observedHas: boolean | undefined;

    validService(accessory, hap.Service.Switch, (hasService) => {

      observedHas = hasService;

      return hasService;
    });

    assert.equal(observedHas, true, "callback must observe the service as present");

    // Now prove the inverse: a service type that was never created should be reported as absent.
    let observedMissing: boolean | undefined;

    validService(accessory, hap.Service.Outlet, (hasService) => {

      observedMissing = hasService;

      return hasService;
    });

    assert.equal(observedMissing, false, "callback must observe an uncreated service type as absent");
  });

  test("callback form removes the service when it returns false", () => {

    const accessory = makeAccessory();

    acquireService(accessory, hap.Service.Switch, "Conditional");

    const kept = validService(accessory, hap.Service.Switch, () => false);

    assert.equal(kept, false);
    assert.equal(accessory.getService(hap.Service.Switch), undefined);
  });

  test("respects subtype when locating the service to validate", () => {

    // Only the matching-subtype service should be considered and (when invalidated) removed. The sibling subtype must survive a `validService(...sub-a, false)` call.
    const accessory = makeAccessory();

    acquireService(accessory, hap.Service.Switch, "Alpha", "sub-a");
    acquireService(accessory, hap.Service.Switch, "Beta", "sub-b");

    assert.equal(validService(accessory, hap.Service.Switch, false, "sub-a"), false);
    assert.equal(accessory.getServiceById(hap.Service.Switch, "sub-a"), undefined, "matching-subtype service must be removed");
    assert.ok(accessory.getServiceById(hap.Service.Switch, "sub-b"), "non-matching-subtype service must remain");
  });
});

describe("validCharacteristic", () => {

  test("a true verdict attaches a missing characteristic and answers true", () => {

    // The additive half: the service carries nothing, the verdict is true, and the applier attaches. The single configuration change is the attach itself, which
    // is what distinguishes an attach from a lookup that found something already there.
    const { configurations, gate, service } = gateFixture();

    assert.equal(gate(true), true);
    assert.equal(service.testCharacteristic(hap.Characteristic.StatusTampered), true, "a true verdict must attach the characteristic");
    assert.equal(configurations(), 1, "the attach must raise exactly one configuration change");
  });

  test("a true verdict keeps a present characteristic as the same object and raises no configuration change", () => {

    // Attaching is a lookup, and a lookup on a service that already carries the characteristic answers the object it already has. Identity is what proves the
    // applier did not take the characteristic away and build a fresh one, which would drop any handler bound to it and reset the value HomeKit holds.
    const { configurations, gate, service } = gateFixture();

    gate(true);

    const attached = service.getCharacteristic(hap.Characteristic.StatusTampered);
    const before = configurations();

    assert.equal(gate(true), true);
    assert.equal(service.getCharacteristic(hap.Characteristic.StatusTampered), attached, "the characteristic must survive as the same object");
    assert.equal(configurations(), before, "a repeat true verdict must reconfigure nothing");
  });

  test("a false verdict removes a present characteristic and answers false", () => {

    // The subtractive half: the characteristic is there, the verdict is false, and the answer matches what the service carries once the applier returns. The one
    // additional configuration change is the detach.
    const { configurations, gate, service } = gateFixture();

    gate(true);

    const before = configurations();

    assert.equal(gate(false), false);
    assert.equal(service.testCharacteristic(hap.Characteristic.StatusTampered), false, "a false verdict must remove the characteristic");
    assert.equal(configurations(), before + 1, "the detach must raise exactly one configuration change");
  });

  test("a false verdict on a service that never carried the characteristic attaches nothing", () => {

    // Why presence is read through `testCharacteristic`: an applier that looked the characteristic up before removing it would attach and detach it, leaving the
    // service carrying nothing but charging two configuration changes for the round trip. The count is what tells that path apart from this one.
    const { configurations, gate, service } = gateFixture();

    assert.equal(gate(false), false);
    assert.equal(service.testCharacteristic(hap.Characteristic.StatusTampered), false, "a false verdict must leave the characteristic absent");
    assert.equal(configurations(), 0, "a characteristic the service never carried must never be materialized");
  });

  test("the function form receives the current presence and its verdict decides", () => {

    // The predicate is handed the presence read before the verdict, which is what lets a caller write add-if-missing policies like `(has) => has || flag`. The
    // second pass sees the characteristic the first pass attached, so the pair proves the argument tracks the service rather than being a constant.
    const { gate, service } = gateFixture();
    const seen: boolean[] = [];

    assert.equal(gate((has) => {

      seen.push(has);

      return true;
    }), true);

    assert.deepEqual(seen, [false], "the first pass must observe the characteristic as absent");
    assert.equal(service.testCharacteristic(hap.Characteristic.StatusTampered), true, "a true verdict must attach the characteristic");

    assert.equal(gate((has) => {

      seen.push(has);

      return false;
    }), false);

    assert.deepEqual(seen, [ false, true ], "the second pass must observe the characteristic the first pass attached");
    assert.equal(service.testCharacteristic(hap.Characteristic.StatusTampered), false, "a false verdict must remove the characteristic");
  });

  test("a capabilityGate predicate applies to a characteristic: a lapsed capability keeps a present one and adds no missing one, and a false toggle removes", () => {

    // The gate composes at either level unchanged, which is the whole reason the applier takes the same predicate shape as its service-level counterpart: the
    // conservative half keeps a characteristic the service already carries through a transient capability-false while declining to add a missing one, and the
    // absolute half removes on a user toggle turned off whatever the capability reports.
    const lapsed = gateFixture();

    lapsed.gate(true);

    assert.equal(lapsed.gate(capabilityGate({ capability: false, toggle: true })), true, "a lapsed capability must keep a characteristic already attached");
    assert.equal(lapsed.service.testCharacteristic(hap.Characteristic.StatusTampered), true);

    const missing = gateFixture();

    assert.equal(missing.gate(capabilityGate({ capability: false, toggle: true })), false, "a lapsed capability must add no characteristic");
    assert.equal(missing.configurations(), 0, "a characteristic the capability has not vouched for must never be materialized");

    const disabled = gateFixture();

    disabled.gate(true);

    assert.equal(disabled.gate(capabilityGate({ capability: true, toggle: false })), false, "a disabled toggle must remove the characteristic");
    assert.equal(disabled.service.testCharacteristic(hap.Characteristic.StatusTampered), false);
  });
});

describe("capabilityGate", () => {

  test("the user toggle is absolute: a false toggle removes the service across every capability and existence cell", () => {

    // The toggle is the absolute override. When the user disables the feature the predicate votes false across both (hasService) inputs and both capability values, so
    // an existing service is pruned and a missing one is never created. This asserts every toggle-false cell.
    for(const capability of [ false, true ]) {

      const gate = capabilityGate({ capability, toggle: false });

      assert.equal(gate(false), false, "a disabled toggle must never create a service");
      assert.equal(gate(true), false, "a disabled toggle must prune an existing service");
    }
  });

  test("the capability is conservative: a capability-false keeps an existing service but adds no new one", () => {

    // With the toggle on but the capability not yet reporting, the conservative half keeps an existing service through the transient capability-false window, while
    // still declining to create one that does not exist.
    const gate = capabilityGate({ capability: false, toggle: true });

    assert.equal(gate(false), false, "a toggle-on, capability-false gate must not create a service that does not exist");
    assert.equal(gate(true), true, "a toggle-on, capability-false gate must keep an existing service through a transient capability-false");
  });

  test("the capability is additive-eager: a capability-true creates a missing service and keeps an existing one", () => {

    // With the toggle on and the capability reporting, the additive-eager half creates the service when it is missing and keeps it when it already exists.
    const gate = capabilityGate({ capability: true, toggle: true });

    assert.equal(gate(false), true, "a toggle-on, capability-true gate must create the service when it is missing");
    assert.equal(gate(true), true, "a toggle-on, capability-true gate must keep an existing service");
  });
});

describe("updatePresenceCharacteristic", () => {

  test("a reported reading attaches the characteristic, writes the value, and binds a read-through that answers the live reading", async () => {

    // The additive half in full: a reported reading is the only input that creates anything, and what it binds has to answer from the record rather than from
    // the pass that bound it, so a later reading reaches HomeKit through a pull with no pass in between.
    const { pass, reading, service } = presenceFixture();

    reading({ state: "reported", value: 3 });
    pass(true);

    assert.equal(service.testCharacteristic(hap.Characteristic.PM2_5Density), true, "a reported reading must attach the characteristic");
    assert.equal(service.getCharacteristic(hap.Characteristic.PM2_5Density).value, 3, "and must write the value the reading carries");

    reading({ state: "reported", value: 9 });

    assert.equal(await service.getCharacteristic(hap.Characteristic.PM2_5Density).handleGetRequest(), 9,
      "a pull must answer the live reading rather than the value the binding pass wrote");
  });

  test("a pending reading holds the characteristic and its value, writes nothing, and a pull answers the held value", async () => {

    // The momentary gap between readings. HomeKit keeps showing the last number the sensor gave, and the zero write delta is what proves the hold is a hold: an
    // unchanged-value write raises the change count exactly as a changed one does, so only a count that stands still means nothing was written.
    const { changes, pass, reading, service } = presenceFixture();

    reading({ state: "reported", value: 3 });
    pass(true);

    const written = changes();

    reading({ state: "pending" });
    pass(true);

    assert.equal(service.testCharacteristic(hap.Characteristic.PM2_5Density), true, "a pending reading must keep the characteristic");
    assert.equal(service.getCharacteristic(hap.Characteristic.PM2_5Density).value, 3, "and must leave the value HomeKit already holds");
    assert.equal(changes(), written, "and must write nothing");
    assert.equal(await service.getCharacteristic(hap.Characteristic.PM2_5Density).handleGetRequest(), 3, "and a pull must answer the held value");
  });

  test("an unreachable device holds the characteristic even as its metric leaves liveness", () => {

    // Reachability is the second half of the hold. The metric has genuinely gone, but a device that cannot be seen cannot be believed about it, so the
    // characteristic and its value both stay until the device is back to confirm the loss.
    const { changes, pass, reading, service } = presenceFixture();

    reading({ state: "reported", value: 3 });
    pass(true);

    const written = changes();

    reading({ state: "absent" });
    pass(false);

    assert.equal(service.testCharacteristic(hap.Characteristic.PM2_5Density), true, "an unreachable device must keep the characteristic");
    assert.equal(service.getCharacteristic(hap.Characteristic.PM2_5Density).value, 3, "and must keep the value HomeKit already holds");
    assert.equal(changes(), written, "and must write nothing");
  });

  test("an absent reading on a reachable device removes the characteristic", () => {

    // The subtractive half, and the only input that removes anything: the metric has left liveness while the device can be seen, which is a real loss of the
    // metric rather than a quiet spell.
    const { pass, reading, service } = presenceFixture();

    reading({ state: "reported", value: 3 });
    pass(true);

    reading({ state: "absent" });
    pass(true);

    assert.equal(service.testCharacteristic(hap.Characteristic.PM2_5Density), false, "an absent reading on a reachable device must remove the characteristic");
  });

  test("an absent reading on a service that never carried the characteristic attaches nothing", () => {

    // Prior existence is read side-effect-free. An unguarded `getCharacteristic` would attach the characteristic and then take it straight back off, raising the
    // configuration count twice on a pass whose whole job here is to leave the accessory's configuration exactly as it found it.
    const { configurations, pass, reading, service } = presenceFixture();
    const configured = configurations();

    reading({ state: "absent" });
    pass(true);

    assert.equal(service.testCharacteristic(hap.Characteristic.PM2_5Density), false, "a service that never carried the characteristic must not gain it");
    assert.equal(configurations(), configured, "and the pass must raise no configuration change at all");
  });

  test("a reported reading after a removal re-attaches with the new value and a working read-through", async () => {

    // A re-attached characteristic is a fresh object with nothing bound to it, so a helper that bound its read-through only where it attached would leave this
    // one answering the value HomeKit holds for the life of the process. The second pull is what tells the two apart.
    const { pass, reading, service } = presenceFixture();

    reading({ state: "reported", value: 3 });
    pass(true);

    reading({ state: "absent" });
    pass(true);

    reading({ state: "reported", value: 5 });
    pass(true);

    assert.equal(service.testCharacteristic(hap.Characteristic.PM2_5Density), true, "a reported reading must re-attach the characteristic");
    assert.equal(service.getCharacteristic(hap.Characteristic.PM2_5Density).value, 5, "and must write the value the new reading carries");

    reading({ state: "reported", value: 8 });

    assert.equal(await service.getCharacteristic(hap.Characteristic.PM2_5Density).handleGetRequest(), 8,
      "and the re-attached characteristic must read through to the record");
  });

  test("a characteristic that exists without a handler gains one on the next reported pass", async () => {

    // The shape an accessory cache restore leaves behind: the characteristic is present and carries a value, with nothing bound to it. Binding on every reported
    // pass is what gets a handler onto it, where a helper that bound only on an attach would answer 6 to every pull this service ever sees.
    const { pass, reading, service } = presenceFixture();

    service.addCharacteristic(hap.Characteristic.PM2_5Density).updateValue(4);

    reading({ state: "reported", value: 6 });
    pass(true);

    assert.equal(service.getCharacteristic(hap.Characteristic.PM2_5Density).value, 6, "a reported pass must write over the value the characteristic carried");

    reading({ state: "reported", value: 11 });

    assert.equal(await service.getCharacteristic(hap.Characteristic.PM2_5Density).handleGetRequest(), 11, "and the pull must answer the live reading");
  });

  test("a reported reading attaches and writes even while the device is unreachable", async () => {

    // The additive half asks nothing about reachability. The guarantee is asymmetric: growth is welcome the moment data arrives, and only the removal half
    // waits until the device can be seen, so a metric that keeps reporting through an offline window still reaches HomeKit.
    const { pass, reading, service } = presenceFixture();

    reading({ state: "reported", value: 3 });
    pass(false);

    assert.equal(service.testCharacteristic(hap.Characteristic.PM2_5Density), true, "a reported reading must attach whatever reachability says");
    assert.equal(service.getCharacteristic(hap.Characteristic.PM2_5Density).value, 3, "and must write the value the reading carries");

    reading({ state: "reported", value: 9 });

    assert.equal(await service.getCharacteristic(hap.Characteristic.PM2_5Density).handleGetRequest(), 9, "and must bind a read-through that answers the record");
  });
});

describe("updateServices", () => {

  test("writes the value to every service carrying the characteristic and leaves every other service alone", () => {

    /* Two carriers of different service types and one non-carrier, so the sweep has to select on the characteristic rather than on a service type or on position.
     * The non-carrier is read with `testCharacteristic` rather than `getCharacteristic`, because the latter attaches what it cannot find and would report the very
     * state this row exists to refuse.
     */
    const { accessory, hapAccessory } = makePlatformAccessory();
    const motion = hapAccessory.addService(hap.Service.MotionSensor, "Motion");
    const contact = hapAccessory.addService(hap.Service.ContactSensor, "Contact");
    const toggle = hapAccessory.addService(hap.Service.Switch, "Toggle");

    motion.addCharacteristic(hap.Characteristic.StatusActive);
    contact.addCharacteristic(hap.Characteristic.StatusActive);

    updateServices(accessory, hap.Characteristic.StatusActive, true);

    assert.equal(motion.getCharacteristic(hap.Characteristic.StatusActive).value, true, "the first carrier must read the swept value");
    assert.equal(contact.getCharacteristic(hap.Characteristic.StatusActive).value, true, "and so must the second, of a different service type");
    assert.equal(toggle.testCharacteristic(hap.Characteristic.StatusActive), false, "a service that does not carry the characteristic must not gain it");
  });

  test("an accessory carrying the characteristic nowhere is left untouched, without a throw", () => {

    // A sweep that matches nothing is an ordinary outcome - a device that does not model the state at all - rather than a caller defect, so it answers by doing nothing.
    const { accessory, hapAccessory } = makePlatformAccessory();
    const toggle = hapAccessory.addService(hap.Service.Switch, "Toggle");

    assert.doesNotThrow(() => updateServices(accessory, hap.Characteristic.StatusActive, true), "a sweep that matches nothing must not throw");
    assert.equal(toggle.testCharacteristic(hap.Characteristic.StatusActive), false, "and no service gains the characteristic");
    assert.equal(informationServiceOf(accessory).testCharacteristic(hap.Characteristic.StatusActive), false,
      "the information service is swept by the same test as any other, so it is left alone too");
  });
});

describe("getServiceName", () => {

  test("returns undefined when no service is provided", () => {

    // The function is explicitly tolerant of an undefined service - callers pass the result of `accessory.getService(...)` directly.
    assert.equal(getServiceName(undefined), undefined);
  });

  test("returns the ConfiguredName value when it is set", () => {

    const accessory = makeAccessory();
    const service = acquireService(accessory, hap.Service.Switch, "Configured");

    assert.ok(service, "the service must exist before we read its name");
    assert.equal(getServiceName(service), "Configured");
  });

  test("prefers ConfiguredName over Name when both are set", () => {

    // Precedence contract: `ConfiguredName ?? Name`. With both characteristics populated we expect the ConfiguredName value to win.
    const accessory = makeAccessory();
    const service = acquireService(accessory, hap.Service.Switch, "Primary");

    assert.ok(service, "the service must exist before we exercise the precedence contract");
    assert.equal(getServiceName(service), "Primary");

    // Distinguish the two by explicitly updating Name to a different value; ConfiguredName must still take precedence in getServiceName's result.
    const nameCharacteristic = resolveCharacteristic(service, "Name");

    assert.ok(nameCharacteristic, "Switch must expose a Name characteristic on its constructor");

    service.updateCharacteristic(nameCharacteristic, "Secondary");

    assert.equal(getServiceName(service), "Primary", "ConfiguredName must win when both are populated");
  });

  test("does not lazily create characteristics on a read (read-only guarantee)", () => {

    // A name lookup must never mutate the accessory. A Fan supports Name but not ConfiguredName, so reading its name exercises the absent-ConfiguredName path. HAP's
    // `getCharacteristic` would lazily attach the missing ConfiguredName (and log an "Adding anyway." warning); `getServiceName` gates reads behind `testCharacteristic`,
    // so the characteristic stays absent. `readNamedCharacteristic` scans `service.characteristics` directly, giving a true present-right-now snapshot.
    const accessory = makeAccessory();
    const service = acquireService(accessory, hap.Service.Fan, "Room Fan");

    assert.ok(service, "the service must exist before we read its name");
    assert.equal(readNamedCharacteristic(service, "ConfiguredName"), undefined, "precondition: a Fan must not carry ConfiguredName");

    const before = service.characteristics.length;

    assert.equal(getServiceName(service), "Room Fan", "the read must fall back to Name when ConfiguredName is absent");
    assert.equal(readNamedCharacteristic(service, "ConfiguredName"), undefined, "getServiceName must not lazily attach ConfiguredName");
    assert.equal(service.characteristics.length, before, "getServiceName must not change the characteristic count");
  });
});

describe("setServiceName", () => {

  test("updates displayName and the supported name characteristics in place", () => {

    const accessory = makeAccessory();
    const service = acquireService(accessory, hap.Service.Switch, "Original");

    assert.ok(service, "the service must exist before setServiceName updates it");

    setServiceName(service, "Renamed");

    assert.equal(service.displayName, "Renamed");
    assert.equal(readNamedCharacteristic(service, "ConfiguredName"), "Renamed");
    assert.equal(readNamedCharacteristic(service, "Name"), "Renamed");
  });

  test("sanitizes the supplied name before storing it", () => {

    // Same sanitization contract as acquireService: setServiceName calls sanitizeName internally so the stored form is always HomeKit-safe regardless of caller input.
    const accessory = makeAccessory();
    const service = acquireService(accessory, hap.Service.Switch, "Original");

    assert.ok(service, "the service must exist before setServiceName sanitizes its rename");

    setServiceName(service, "Rocket \u{1F680} Lamp");

    assert.equal(service.displayName, "Rocket Lamp");
    assert.equal(readNamedCharacteristic(service, "ConfiguredName"), "Rocket Lamp");
    assert.equal(readNamedCharacteristic(service, "Name"), "Rocket Lamp");
  });
});

describe("setAccessoryName", () => {

  test("writes the name to both display names and to the information service", () => {

    const { accessory, hapAccessory } = makePlatformAccessory();

    setAccessoryName(accessory, "Front Porch");

    const information = informationServiceOf(accessory);

    assert.equal(accessory.displayName, "Front Porch", "the platform wrapper's display name");
    assert.equal(hapAccessory.displayName, "Front Porch", "the HAP accessory's display name beneath the wrapper");
    assert.equal(information.displayName, "Front Porch", "the information service's display name");
    assert.equal(readNamedCharacteristic(information, "Name"), "Front Porch", "the Name characteristic");
    assert.equal(readNamedCharacteristic(information, "ConfiguredName"), "Front Porch",
      "ConfiguredName too - it is the user-editable name that makes a rename stick in the Home app");
  });

  test("sanitizes the supplied name once and applies the sanitized form everywhere", () => {

    const { accessory, hapAccessory } = makePlatformAccessory();

    setAccessoryName(accessory, "Rocket \u{1F680} Lamp");

    const information = informationServiceOf(accessory);

    assert.equal(accessory.displayName, "Rocket Lamp");
    assert.equal(hapAccessory.displayName, "Rocket Lamp");
    assert.equal(readNamedCharacteristic(information, "Name"), "Rocket Lamp");
    assert.equal(readNamedCharacteristic(information, "ConfiguredName"), "Rocket Lamp");
  });

  test("a repeat call with the same name leaves the same final state", () => {

    const { accessory, hapAccessory } = makePlatformAccessory();

    setAccessoryName(accessory, "Back Gate");
    setAccessoryName(accessory, "Back Gate");

    const information = informationServiceOf(accessory);

    assert.equal(accessory.displayName, "Back Gate");
    assert.equal(hapAccessory.displayName, "Back Gate");
    assert.equal(readNamedCharacteristic(information, "Name"), "Back Gate");
    assert.equal(readNamedCharacteristic(information, "ConfiguredName"), "Back Gate");
    assert.equal(accessory.services.filter((service) => service.UUID === hap.Service.AccessoryInformation.UUID).length, 1,
      "a rename never adds a second information service");
  });

  test("an accessory with no services at all renames its display names and stops there", () => {

    // The reflection needs a service instance to reach HAP's static registry through, so an accessory carrying none has no information service to delegate to.
    // The display-name writes still land: a partial rename is better than a thrown one, and no real PlatformAccessory reaches this state.
    const { accessory, hapAccessory } = makePlatformAccessory();

    accessory.services.length = 0;

    setAccessoryName(accessory, "Side Yard");

    assert.equal(accessory.displayName, "Side Yard");
    assert.equal(hapAccessory.displayName, "Side Yard");
  });

  test("a name with nothing left after sanitizing is not applied anywhere", () => {

    // An accessory has to answer to something. A name that sanitizes away entirely - punctuation or emoji alone - leaves every name it already had in place,
    // rather than blanking the accessory and its information service.
    const { accessory, hapAccessory } = makePlatformAccessory();

    setAccessoryName(accessory, "Garden Shed");

    const information = informationServiceOf(accessory);

    setAccessoryName(accessory, "\u{1F680}");

    assert.equal(accessory.displayName, "Garden Shed", "the wrapper keeps the name it had");
    assert.equal(hapAccessory.displayName, "Garden Shed", "the HAP accessory keeps it too");
    assert.equal(readNamedCharacteristic(information, "Name"), "Garden Shed", "the information service is not blanked either");
    assert.equal(readNamedCharacteristic(information, "ConfiguredName"), "Garden Shed");
  });
});

describe("notResponding", () => {

  test("refuses every read with the injected status error while unavailable", () => {

    let reads = 0;
    const wrap = notResponding({ errorClass: StatusError, unavailable: () => true });

    const read = wrap((): number => {

      reads++;

      return 42;
    });

    assert.throws(read, (error: unknown) => {

      assert.ok(error instanceof StatusError, "the refusal is an instance of the injected class, not a plain Error");
      assert.equal(error.hapStatus, HAPStatus.SERVICE_COMMUNICATION_FAILURE, "the refusal carries the status HomeKit renders as Not Responding");

      return true;
    });

    // The refusal happens before the read, not after it: a reader that reaches the device would pay for a call whose answer is thrown away, and one with side
    // effects would perform them while the device is unreachable.
    assert.equal(reads, 0, "the wrapped reader never runs while the device is unavailable");
  });

  test("answers the reader while available", () => {

    let reads = 0;
    const wrap = notResponding({ errorClass: StatusError, unavailable: () => false });

    const read = wrap((): number => {

      reads++;

      return 42;
    });

    assert.equal(read(), 42, "an available device answers with what its reader answers");
    assert.equal(reads, 1, "one read runs the reader once");
    assert.equal(read(), 42);
    assert.equal(reads, 2, "and a second read runs it again, rather than answering from anything the wrapper remembered");
  });

  test("passes a null answer through while available", () => {

    let reads = 0;
    const wrap = notResponding({ errorClass: StatusError, unavailable: () => false });

    const read = wrap((): Nullable<number> => {

      reads++;

      return null;
    });

    // HAP renders whatever a get handler answers, and null is one of the answers its own contract carries, so the wrapper hands it back rather than coalescing it
    // to a value the device never reported or refusing a reader that has nothing to report yet.
    assert.equal(read(), null, "a reader that answers null answers null through the wrapper");
    assert.equal(reads, 1, "and the wrapped reader ran to produce it");
  });

  test("carries a named status", () => {

    const read = notResponding({ errorClass: StatusError, status: HAPStatus.RESOURCE_BUSY, unavailable: () => true })((): boolean => true);

    assert.throws(read, (error: unknown) => {

      assert.ok(error instanceof StatusError);
      assert.equal(error.hapStatus, HAPStatus.RESOURCE_BUSY, "a named status is the one the refusal carries");
      assert.notEqual(error.hapStatus, HAPStatus.SERVICE_COMMUNICATION_FAILURE, "and it replaces the default rather than joining it");

      return true;
    });
  });

  test("reads the predicate on every call", () => {

    let unavailable = true;
    const read = notResponding({ errorClass: StatusError, unavailable: () => unavailable })((): string => "Open");

    assert.throws(read, StatusError, "a device that is away when the characteristic is read refuses");

    unavailable = false;

    // Availability flips between reads, which is the whole of the recovery path: nothing rewires the characteristic when a device comes back, so the next read has
    // to consult the predicate again to answer.
    assert.equal(read(), "Open", "the very next read answers once the device is reachable again");

    unavailable = true;

    assert.throws(read, StatusError, "and a device that goes away again refuses on the read after that");
  });

  test("binds the class facts once and wraps many readers", () => {

    let unavailable = false;
    const wrap = notResponding({ errorClass: StatusError, unavailable: () => unavailable });
    const currentPosition = wrap((): number => 40);
    const positionState = wrap((): string => "Stopped");
    const on = wrap((): boolean => true);

    assert.equal(currentPosition(), 40);
    assert.equal(positionState(), "Stopped");
    assert.equal(on(), true);

    unavailable = true;

    // One factory call holds the class facts for every characteristic a device authors, so the readers it wrapped answer and refuse together rather than each
    // carrying its own copy of the rule.
    assert.throws(currentPosition, StatusError, "every reader bound by one factory call refuses together");
    assert.throws(positionState, StatusError);
    assert.throws(on, StatusError);
  });
});
