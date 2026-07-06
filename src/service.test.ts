/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * service.test.ts: Unit tests for the HomeKit service helper utilities in service.ts - acquireService, validService, capabilityGate, getServiceName, setServiceName.
 *
 * The fixture side uses real `@homebridge/hap-nodejs` primitives (Accessory, Service, Characteristic), declared as an explicit devDependency so the test-side
 * Accessory/Service/Characteristic identities match the same HAP package `homebridge` re-exports from its public type surface. The methods we exercise on the
 * hand-constructed `Accessory` are the exact API surface `PlatformAccessory` delegates to at runtime - using the real runtime objects keeps the tests honest against
 * `service.ts`'s reflection-driven characteristic lookup; a hand-rolled mock would force us to replicate the HAP characteristic-constructor map, which is precisely
 * the thing we want to exercise.
 */
import * as hap from "@homebridge/hap-nodejs";
import type { Characteristic, PlatformAccessory, Service, WithUUID } from "homebridge";
import { acquireService, capabilityGate, getServiceName, setServiceName, validService } from "./service.ts";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

// The HAP static-Characteristic shape: every Characteristic class ships with a `UUID` static and satisfies `new () => Characteristic`. That is the exact type HAP's
// `service.updateCharacteristic` accepts and the type whose `UUID` powers identity-matching against `service.characteristics` / `service.optionalCharacteristics`.
type CharacteristicCtor = WithUUID<new () => Characteristic>;

// The two HAP name slots this test file discriminates on. Kept narrow so the reflection helper cannot be called with an arbitrary string and silently return undefined
// for a real-world slot that simply happens not to match the map. Adding more slots is a one-line change if future behavior requires it.
type NamedCharacteristicSlot = "ConfiguredName" | "Name";

// Construct a bare hap-nodejs accessory and cast to PlatformAccessory. PlatformAccessory is a thin wrapper around Accessory whose service-management methods
// (getService, addService, removeService, getServiceById) delegate directly to the underlying HAP instance. For the surfaces this module exercises, the real HAP
// accessory is indistinguishable from PlatformAccessory and keeps the test honest against real HAP internals.
function makeAccessory(): PlatformAccessory {

  return new hap.Accessory("TestAccessory", hap.uuid.generate("homebridge-plugin-utils.service-test.accessory")) as unknown as PlatformAccessory;
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

describe("capabilityGate", () => {

  test("the user toggle is absolute: a false toggle removes the service across every capability and existence cell", () => {

    // The toggle is the absolute override. When the user disables the feature the predicate votes false across both (hasService) inputs and both capability values, so
    // an existing service is pruned and a missing one is never created. This pins all four toggle-false cells.
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

  test("does not lazily create characteristics on a read (read-only invariant)", () => {

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
