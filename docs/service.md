[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / service

# service

Homebridge service helper utilities.

## Accessory

### AcquireServiceTarget

```ts
type AcquireServiceTarget<T> = WithUUID<typeof Service> & (displayName?, subtype?) => T;
```

The constructor shape [acquireService](#acquireservice) expects for a Service subclass. Every HAP Service subclass (Lightbulb, Switch, Television, ...) satisfies both halves
of this intersection naturally:

- `WithUUID<typeof Service>` - provides the static `UUID` property AND assignability to HAP's `getService` / `getServiceById` lookup APIs that require this exact
  shape.
- `new (displayName?: string, subtype?: string) => T` - the actual runtime constructor signature every Service subclass exposes; supersedes the BASE Service
  class's `(displayName, UUID, subtype?)` signature that the wider `WithUUID<typeof Service>` would otherwise surface.

Intersecting both shapes lets the function invoke `new serviceType(sanitized, subtype)` against an honest type-checked signature without any cast or non-null
assertion.

#### Type Parameters

| Type Parameter | Default type | Description |
| ------ | ------ | ------ |
| `T` *extends* `Service` | `Service` | The concrete Service subclass produced by the constructor. Inferred from the call site so callers receive the specific subclass type back. |

***

### acquireService()

```ts
function acquireService<T>(
   accessory, 
   serviceType, 
   name, 
   subtype?, 
onServiceCreate?): Nullable<T>;
```

Utility method that either creates a new service on an accessory if needed, or returns an existing one. Optionally, it executes a callback to initialize a new
service instance. Additionally, the various name characteristics of the service are set to the specified name, and optionally added if necessary.

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| `T` *extends* `Service` | The concrete Service subclass being acquired. Inferred from `serviceType` so callers receive the specific subclass type back rather than the wider `Service` type. |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `accessory` | `PlatformAccessory` | The Homebridge accessory to check or modify. |
| `serviceType` | [`AcquireServiceTarget`](#acquireservicetarget)\<`T`\> | The type of service to instantiate or retrieve. Must be a HAP Service subclass with the standard `(displayName?, subtype?)` constructor; see [AcquireServiceTarget](#acquireservicetarget). |
| `name` | `string` | Name to be displayed to the end user for this service. |
| `subtype?` | `string` | Optional service subtype to uniquely identify the service. |
| `onServiceCreate?` | (`svc`) => `void` | Optional callback invoked only when a new service is created, receiving the new service as its argument. |

#### Returns

[`Nullable`](util.md#nullable)\<`T`\>

Returns the created or retrieved service. Construction failures throw rather than returning `null`.

#### Remarks

This method ensures that the service's display name and available name characteristics are updated to the specified name. If `onServiceCreate` is provided,
it will only be called for newly created services, not for existing ones.

The `ConfiguredName` and `Name` characteristics are conditionally added or updated based on the type of service, in accordance with HomeKit requirements.

#### Example

```typescript
// Example: Ensure a Lightbulb service exists with a user-friendly name, and initialize it if newly created. The return type is narrowed to `Lightbulb | null`,
// so callers can invoke subclass-specific behavior on the result without casts.
const lightbulbService = acquireService(accessory, hap.Service.Lightbulb, "Living Room Lamp", undefined, (svc): void => {

  // Called only if the service is newly created. `svc` is typed as `Lightbulb` here.
  svc.setCharacteristic(hap.Characteristic.On, false);
});

if(lightbulbService) {

  // Service is now available, with display name set and optional characteristics managed.
  lightbulbService.updateCharacteristic(hap.Characteristic.Brightness, 75);
}
```

#### See

 - setServiceName - updates the newly created (or existing) service's name-related characteristics.
 - validService - validate or prune services after acquisition.

***

### capabilityGate()

```ts
function capabilityGate(options): (hasService) => boolean;
```

Build a `validService` predicate for a service gated on a hardware capability and a user toggle, applying an additive-eager / subtractive-conservative asymmetry
between the two: the user `toggle` is absolute - when false, the service is removed - while the hardware `capability` is conservative - an existing service is kept
through a transient capability-false, and a new service is created only when the capability reports.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | \{ `capability`: `boolean`; `toggle`: `boolean`; \} | The `capability` and `toggle` inputs for the gate. |
| `options.capability` | `boolean` | - |
| `options.toggle` | `boolean` | - |

#### Returns

A `validService` function-form predicate, `(hasService) => toggle && (hasService || capability)`.

(`hasService`) => `boolean`

#### Remarks

Pass the result as `validService`'s `validate` argument. The asymmetry keeps a capability-gated service from being removed during a transient window in which the
device under-reports its capability, while still honoring a user who disables the service. A service with no user toggle should gate on its capability directly.

#### Example

```typescript
// Keep the service while its user toggle is on, add it when the capability reports, and keep an existing one through a transient capability-false.
validService(accessory, Service.Switch, capabilityGate({ capability: deviceReportsFeature, toggle: config.enableSwitch }));
```

#### See

validService - consumes the returned predicate.

***

### getServiceName()

```ts
function getServiceName(service?): string | undefined;
```

Retrieves the primary name of a service, preferring the ConfiguredName characteristic over the Name characteristic. This is a pure read - it never mutates the
service.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `service?` | `Service` | The service from which to retrieve the name. |

#### Returns

`string` \| `undefined`

The configured or display name of the service, or `undefined` if neither characteristic is present or set.

#### See

setServiceName - to update the current name on a service.

***

### setServiceName()

```ts
function setServiceName(service, name): void;
```

Updates the displayName and applicable name characteristics of a service to the specified value.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `service` | `Service` | The service to update. |
| `name` | `string` | The new name to apply to the service. |

#### Returns

`void`

#### Remarks

This function ensures the name is validated, updates the service's `displayName`, and sets the `ConfiguredName` and `Name`
characteristics when supported by the service type.

#### See

 - acquireService - to add or retrieve services.
 - getServiceName - to retrieve the current name set on a service.

***

### validService()

```ts
function validService(
   accessory, 
   serviceType, 
   validate, 
   subtype?): boolean;
```

Validates whether a specific service should exist on the given accessory, removing the service if it fails validation.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `accessory` | `PlatformAccessory` | The Homebridge accessory to inspect and potentially modify. |
| `serviceType` | `WithUUID`\<*typeof* `Service`\> | The type of Homebridge service being checked or instantiated. |
| `validate` | `boolean` \| ((`hasService`) => `boolean`) | A boolean or a function that determines if the service should exist. If a function is provided, it receives a boolean indicating whether the service currently exists, and should return `true` to keep the service, or `false` to remove it. |
| `subtype?` | `string` | Optional service subtype to uniquely identify the service. |

#### Returns

`boolean`

`true` if the service is valid (and kept), or `false` if it was removed.

#### Remarks

The `validate` parameter can be either:
  - a boolean (where `true` means keep the service, `false` means remove it).
  - a function (which is called with `hasService: boolean` and returns whether to keep the service).

If the service should not exist according to `validate`, and it is currently present, this function will remove it from the accessory.

#### Example

```typescript
// Remove a service if it exists
validService(accessory, Service.Switch, false);

// Only keep a service if a configuration flag is true
validService(accessory, Service.Switch, config.enableSwitch);

// Keep a service if it currently exists, or add it if a certain condition is met
validService(accessory, Service.Switch, (hasService) => hasService || config.enableSwitch);
```

#### See

acquireService - to add or retrieve services.
