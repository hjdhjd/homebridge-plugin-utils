[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / service

# service

Homebridge service helper utilities.

## Accessory

### NotRespondingOptions

The facts about a device that [notResponding](#notresponding) binds once: the class a refusal is constructed from, the status it carries, and the predicate it reads.

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="errorclass"></a> `errorClass` | `readonly` | (`status`) => `Error` | The plugin's `api.hap.HapStatusError`, typed by its constructor shape so a plugin's own status-error double fits it as readily as the HAP class does. The type describes the constructor and not what it does with what it is handed, so a class that ignores the status satisfies it too...the tests assert the status a refusal carries rather than only the class it is an instance of. |
| <a id="status"></a> `status?` | `readonly` | `HAPStatus` | The HAP status a refusal carries. Defaults to `HAPStatus.SERVICE_COMMUNICATION_FAILURE`, the status HomeKit renders as Not Responding, so a consumer names one only when it means a different status. |
| <a id="unavailable"></a> `unavailable` | `readonly` | () => `boolean` | The plugin's own availability composition, answering `true` while the device cannot be reached. It is read on each wrapped read rather than captured when the wrapper is built: a device that goes offline refuses on the very next read, and one that comes back answers on it. |

***

### PresenceCharacteristicOptions

The inputs [updatePresenceCharacteristic](#updatepresencecharacteristic) reconciles one characteristic's presence from: the characteristic itself, the service it lives on, the
read-through behind it, and whether the device can currently be seen.

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="characteristic"></a> `characteristic` | `readonly` | [`CharacteristicTarget`](#characteristictarget) | The characteristic whose presence on the service follows the reading behind it. |
| <a id="reachable"></a> `reachable` | `readonly` | `boolean` | Whether the device can currently be seen. A removal is believed only when it can, so a device that has dropped off keeps every characteristic it had. |
| <a id="read"></a> `read` | `readonly` | () => [`PresenceReading`](#presencereading) | The read-through behind the characteristic, called on every pass and on every HomeKit pull so the bound handler answers from the record at pull time rather than from whatever was true when it was bound. |
| <a id="service"></a> `service` | `readonly` | `Service` | The service the characteristic lives on. |

***

### ValidCharacteristicOptions

The inputs [validCharacteristic](#validcharacteristic) reconciles one characteristic's presence from: the characteristic itself, the service it lives on, and the verdict
that decides whether it should exist.

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="characteristic-1"></a> `characteristic` | `readonly` | [`CharacteristicTarget`](#characteristictarget) | The characteristic whose presence on the service follows the verdict. |
| <a id="service-1"></a> `service` | `readonly` | `Service` | The service the characteristic lives on. |
| <a id="validate"></a> `validate` | `readonly` | `boolean` \| ((`hasCharacteristic`) => `boolean`) | A boolean, or a predicate handed the characteristic's current presence and answering whether it should exist. |

***

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

### CharacteristicTarget

```ts
type CharacteristicTarget = WithUUID<typeof Characteristic> & () => Characteristic;
```

The characteristic class both HAP calls in [updateServices](#updateservices) are handed: `testCharacteristic` matches a service's attached characteristics against the class's
static `UUID`, while `updateCharacteristic` takes the same class as something it can construct from, since HAP builds the characteristic when the service it is
called on does not already carry one. Intersecting both shapes lets a caller hand over `Characteristic.StatusActive` and have each call type-check against the
half of the shape it actually uses, with no cast at the call site.

***

### PresenceReading

```ts
type PresenceReading = 
  | {
  state: "reported";
  value: CharacteristicValue;
}
  | {
  state: "pending";
}
  | {
  state: "absent";
};
```

The reading a consumer's liveness policy maps its metric into, handed to [updatePresenceCharacteristic](#updatepresencecharacteristic) on every pass: `reported` carries the value
HomeKit shows, `pending` means the metric is still reporting but has no number at this instant - the momentary gap between readings - and `absent` means the
metric has left liveness, having stopped reporting rather than merely gone quiet.

***

### acquireService()

```ts
function acquireService<T>(
   accessory, 
   serviceType, 
   name, 
   subtype?, 
   onServiceCreate?
): T;
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

`T`

Returns the created or retrieved service. Construction failures throw rather than returning `null`.

#### Remarks

This method ensures that the service's display name and available name characteristics are updated to the specified name. If `onServiceCreate` is provided,
it will only be called for newly created services, not for existing ones.

The `ConfiguredName` and `Name` characteristics are conditionally added or updated based on the type of service, in accordance with HomeKit requirements.

#### Example

```typescript
// Example: Ensure a Lightbulb service exists with a user-friendly name, and initialize it if newly created. The return type is narrowed to `Lightbulb`, so
// callers invoke subclass-specific behavior on the result without casts.
const lightbulbService = acquireService(accessory, hap.Service.Lightbulb, "Living Room Lamp", undefined, (svc): void => {

  // Called only if the service is newly created. `svc` is typed as `Lightbulb` here.
  svc.setCharacteristic(hap.Characteristic.On, false);
});

// Service is now available, with display name set and optional characteristics managed.
lightbulbService.updateCharacteristic(hap.Characteristic.Brightness, 75);
```

#### See

 - setServiceName - updates the newly created (or existing) service's name-related characteristics.
 - validService - validate or prune services after acquisition.

***

### capabilityGate()

```ts
function capabilityGate(options): (present) => boolean;
```

Build a presence predicate for a service or a characteristic gated on a hardware capability and a user toggle, applying an additive-eager /
subtractive-conservative asymmetry between the two: the user `toggle` is absolute - when false, what it gates is removed - while the hardware `capability`
is conservative - an existing service is kept through a transient capability-false, and a missing one is added only when the capability reports.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | \{ `capability`: `boolean`; `toggle`: `boolean`; \} | The `capability` and `toggle` inputs for the gate. |
| `options.capability` | `boolean` | - |
| `options.toggle` | `boolean` | - |

#### Returns

A function-form predicate for `validService` or `validCharacteristic`, `(present) => toggle && (present || capability)`.

(`present`) => `boolean`

#### Remarks

Pass the result as the `validate` argument of `validService` or `validCharacteristic`. The asymmetry keeps a capability-gated service from being removed
during a transient window in which the device under-reports its capability, while still honoring a user who disables the service. A service with no user
toggle should gate on its capability directly.

#### Example

```typescript
// Keep the service while its user toggle is on, add it when the capability reports, and keep an existing one through a transient capability-false.
validService(accessory, Service.Switch, capabilityGate({ capability: deviceReportsFeature, toggle: config.enableSwitch }));
```

#### See

 - validService - consumes the returned predicate.
 - validCharacteristic - consumes the returned predicate for one characteristic on a service.
 - updatePresenceCharacteristic - the same asymmetry, applied to one characteristic's presence on a service.

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

### notResponding()

```ts
function notResponding(options): <T>(read) => () => T;
```

Binds a device's Not Responding rule once and returns a wrapper that makes any characteristic reader refuse to answer while the device is unavailable.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`NotRespondingOptions`](#notrespondingoptions) | The error class, the status, and the availability predicate every wrapped read answers by. See [NotRespondingOptions](#notrespondingoptions). |

#### Returns

A wrapper that takes any characteristic reader HAP's own get handler may be - one that answers a value, or one that answers null - and returns a reader
         of the same shape, throwing while `unavailable()` is true and reading through to the wrapped reader otherwise.

\<`T`\>(`read`) => () => `T`

#### Remarks

HomeKit renders a get handler that throws a HAP status error as Not Responding, and renders whatever a handler returns as fact. A readable characteristic wired
around this rule therefore answers a stale value while its device cannot be reached, which is the dishonest display the rule exists to avoid...wiring every
readable characteristic through the wrapper leaves exactly one place that decides whether the device can answer at all.

The error class is injected rather than imported because this library holds `homebridge` and `@homebridge/hap-nodejs` as development dependencies alone and
carries no HAP dependency at runtime: `HapStatusError` reaches a plugin as a member of the runtime `api.hap` namespace, and the plugin is the only holder of it.
The class, the status, and the predicate are facts about a device, while a reader is a fact about one characteristic, so the two bind at different moments - the
device binds the rule once, then wraps each reader as it wires it.

#### Example

```typescript
// Bind the rule once, where the device composes its own availability.
this.answering = notResponding({ errorClass: api.hap.HapStatusError, unavailable: () => this.offline || this.unreachable });

// Wire a characteristic through it. The reader answers while the device is reachable, and never runs while it is not.
service.getCharacteristic(Characteristic.On).onGet(this.answering(() => this.active));
```

#### See

capabilityGate - the same bind-once shape, applied to whether a service should exist at all.

***

### setAccessoryName()

```ts
function setAccessoryName(accessory, name): void;
```

Updates the display name of an accessory and of its AccessoryInformation service to the specified value.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `accessory` | `PlatformAccessory` | The accessory to rename. |
| `name` | `string` | The new name to apply to the accessory. |

#### Returns

`void`

#### Remarks

An accessory carries its name in more than one place, and a rename that reaches only some of them leaves the accessory answering to two names. This writes all
of them from one sanitized source, then hands each pair to whichever API owns it: Homebridge's `updateDisplayName` owns the accessory display names (the
`PlatformAccessory`'s own and the HAP accessory's beneath it), and [setServiceName](#setservicename) owns the AccessoryInformation service's `ConfiguredName` and `Name`
characteristics. `ConfiguredName` is what makes a rename stick in the Home app, since it is the name a user can edit there.

The name is sanitized through the same HomeKit naming rules [acquireService](#acquireservice) applies, so a caller may pass a raw device name straight through. A name with
nothing left after sanitizing is not applied anywhere: an accessory has to answer to something, and a blank one is worse than the name it already had.

#### Example

```typescript
// Rename an accessory after the device reports a new name.
setAccessoryName(accessory, device.name);
```

#### See

 - setServiceName - the per-service equivalent this delegates its characteristic writes to.
 - getServiceName - to retrieve the current name set on a service.

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
 - setAccessoryName - the accessory-level equivalent, which delegates its information-service write here.

***

### updatePresenceCharacteristic()

```ts
function updatePresenceCharacteristic(options): void;
```

Reconcile one characteristic's presence on a service against the reading behind it, applying the same additive-eager / subtractive-conservative asymmetry
[capabilityGate](#capabilitygate) applies to services, one level down.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`PresenceCharacteristicOptions`](#presencecharacteristicoptions) | The characteristic, its service, the read-through behind it, and the device's reachability. See [PresenceCharacteristicOptions](#presencecharacteristicoptions). |

#### Returns

`void`

#### Remarks

Every outcome follows from one read of the reading. ADD or UPDATE: a reported reading attaches the characteristic and writes the value it carries, with no
reachability gate on this half, because the guarantee is asymmetric - the characteristic set never shrinks outside a real loss of the metric, while growth is
welcome the moment data arrives. HOLD: a pending reading, or a device that cannot be seen, writes nothing and removes nothing, so a momentary gap between
readings or an offline window leaves HomeKit showing the last thing the sensor said. REMOVE: an absent reading on a reachable device takes the characteristic
away, the one case in which the metric genuinely stopped reporting rather than merely going quiet.

The read-through is bound on every reported pass rather than only where the characteristic is attached. A characteristic restored from the accessory cache, or
re-attached by HAP after a removal, is a fresh object carrying no handler and answering its own cached value, and HAP replaces a bound handler rather than
stacking one, so rebinding every pass is what keeps a pull honest and costs nothing.

#### Example

```typescript
// Follow one metric's liveness, mapping the sensor's own metric into a reading.
updatePresenceCharacteristic({ characteristic: Characteristic.PM2_5Density, reachable: this.isReachable, read: () => toReading(this.metric), service });
```

#### See

capabilityGate - the same asymmetry, applied to whether a service should exist at all.

***

### updateServices()

```ts
function updateServices(
   accessory, 
   characteristic, 
   value
): void;
```

Write one characteristic value to every service on an accessory that carries that characteristic, leaving every other service untouched.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `accessory` | `PlatformAccessory` | The Homebridge accessory whose services are swept. |
| `characteristic` | [`CharacteristicTarget`](#characteristictarget) | The characteristic to write, matched against each service by the class's static UUID. |
| `value` | `CharacteristicValue` | The value written to every service that carries the characteristic. |

#### Returns

`void`

#### Remarks

A device-wide state - reachability, tamper, an availability flag - belongs on several of an accessory's services at once, and which services those are depends on
what the device turned out to support. Selecting by the characteristic rather than by a roster of service types is what keeps that correct without anyone
maintaining the roster: a service added later is swept the moment it carries the characteristic, and a service that never carries it is never written to. The
test is also what keeps the sweep from creating anything, because HAP's `updateCharacteristic` attaches a characteristic the service is missing - an unguarded walk
would dress every service on the accessory instead of the ones that model the state.

The AccessoryInformation service needs no exception of its own. It carries none of the state characteristics a caller sweeps, so the same test passes over it.

#### Example

```typescript
// Project a device-wide reachability state onto every service that models it.
updateServices(accessory, hap.Characteristic.StatusActive, isReachable);
```

***

### validCharacteristic()

```ts
function validCharacteristic(options): boolean;
```

Validate whether a specific characteristic should exist on the given service, attaching it when it should and removing it when it should not.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`ValidCharacteristicOptions`](#validcharacteristicoptions) | The characteristic, the service it lives on, and the verdict that decides its presence. See [ValidCharacteristicOptions](#validcharacteristicoptions). |

#### Returns

`boolean`

`true` if the characteristic is valid (and present afterward), or `false` if it was removed or never attached.

#### Remarks

The `validate` parameter can be either:
  - a boolean (where `true` means the characteristic should exist, `false` means remove it).
  - a function (which is called with `hasCharacteristic: boolean` and returns whether the characteristic should exist).

Presence is read without attaching, so a characteristic the service never carried is never materialized only to be removed. A true verdict attaches through
the service's own lookup, which adds an optional characteristic the service lacks and answers the existing one otherwise...the answer therefore equals the
characteristic's presence once the call returns. The helper is meant for a characteristic the service declares optional. HAP attaches a characteristic
outside a service's declared sets too, with a warning, and nothing here guards against that.

#### Example

```typescript
// Attach the characteristic while a configuration fact holds, and remove it otherwise.
validCharacteristic({ characteristic: Characteristic.StatusFault, service, validate: hasCredentials });

// Keep the characteristic if the service already carries it, or add it when the user asks for it.
validCharacteristic({ characteristic: Characteristic.StatusTampered, service, validate: (has) => has || config.showTamper });

// Gate the characteristic on a hardware capability and a user toggle.
validCharacteristic({ characteristic: Characteristic.StatusTampered, service,
  validate: capabilityGate({ capability: device.reportsTamper, toggle: config.tamperDetection }) });
```

#### See

 - validService - the same contract, applied to whether a service should exist on an accessory.
 - capabilityGate - builds a predicate for either applier.

***

### validService()

```ts
function validService(
   accessory, 
   serviceType, 
   validate, 
   subtype?
): boolean;
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

 - acquireService - to add or retrieve services.
 - validCharacteristic - the same contract, applied to one characteristic's presence on a service.
