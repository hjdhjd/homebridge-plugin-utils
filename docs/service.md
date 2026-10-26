[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / service

# service

Homebridge service helper utilities.

## Accessory

### AcquireServiceOptions

The inputs [acquireService](#acquireservice) creates or retrieves a service from: everything [findService](#findservice) identifies the service by, plus the display name a newly
created service takes and an optional callback fired only on creation.

#### Extends

- [`FindServiceOptions`](#findserviceoptions)\<`T`\>

#### Extended by

- [`ValidServiceOptions`](#validserviceoptions)

#### Type Parameters

| Type Parameter | Default type | Description |
| ------ | ------ | ------ |
| <a id="type-parameter-t"></a> `T` *extends* `Service` | `Service` | The concrete Service subclass being acquired. Inferred from `serviceType` so callers receive the specific subclass type back. |

#### Properties

| Property | Modifier | Type | Description | Inherited from |
| ------ | ------ | ------ | ------ | ------ |
| <a id="accessory"></a> `accessory` | `readonly` | `PlatformAccessory` | The Homebridge accessory to check or modify. | [`FindServiceOptions`](#findserviceoptions).[`accessory`](#accessory-1) |
| <a id="name"></a> `name` | `readonly` | `string` | Name to be displayed to the end user for this service. | - |
| <a id="onservicecreate"></a> `onServiceCreate?` | `readonly` | (`svc`) => `void` | Optional callback invoked only when a new service is created, receiving the new service as its argument. | - |
| <a id="servicetype"></a> `serviceType` | `readonly` | [`AcquireServiceTarget`](#acquireservicetarget)\<`T`\> | The type of service to instantiate or retrieve. Must be a HAP Service subclass with the standard `(displayName?, subtype?)` constructor; see [AcquireServiceTarget](#acquireservicetarget). | [`FindServiceOptions`](#findserviceoptions).[`serviceType`](#servicetype-1) |
| <a id="subtype"></a> `subtype?` | `readonly` | `string` | Optional service subtype to uniquely identify the service. | [`FindServiceOptions`](#findserviceoptions).[`subtype`](#subtype-1) |

***

### AcquireServiceResult

The service [acquireService](#acquireservice) answers, and the transition it performed to answer it: `"attached"` when this call created the service, `"kept"`
when it already existed. This is the present arm of [ValidServiceResult](#validserviceresult), reused rather than declared a second time, since a successful
acquisition and a validated service that already existed or was just created are the same fact.

#### Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| <a id="type-parameter-t-1"></a> `T` *extends* `Service` | `Service` |

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="service"></a> `service` | `readonly` | `T` | The service [acquireService](#acquireservice) found or created. |
| <a id="transition"></a> `transition` | `readonly` | `"attached"` \| `"kept"` | The transition this call performed to answer the service: `"attached"` when this call created it, `"kept"` when it already existed. |

***

### FindServiceOptions

The inputs [findService](#findservice) identifies a service by: the accessory, the service type, and an optional subtype disambiguating more than one service of the
same type.

#### Extended by

- [`AcquireServiceOptions`](#acquireserviceoptions)

#### Type Parameters

| Type Parameter | Default type | Description |
| ------ | ------ | ------ |
| <a id="type-parameter-t-2"></a> `T` *extends* `Service` | `Service` | The concrete Service subclass being looked up. Inferred from `serviceType` so callers receive the specific subclass type back. |

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="accessory-1"></a> `accessory` | `readonly` | `PlatformAccessory` | The Homebridge accessory to check or modify. |
| <a id="servicetype-1"></a> `serviceType` | `readonly` | [`AcquireServiceTarget`](#acquireservicetarget)\<`T`\> | The type of service to instantiate or retrieve. Must be a HAP Service subclass with the standard `(displayName?, subtype?)` constructor; see [AcquireServiceTarget](#acquireservicetarget). |
| <a id="subtype-1"></a> `subtype?` | `readonly` | `string` | Optional service subtype to uniquely identify the service. |

***

### NotRespondingOptions

The facts about a device that [notResponding](#notresponding) binds once: the class a refusal is constructed from, the status it carries, and the predicate it reads.

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="errorclass"></a> `errorClass` | `readonly` | new (`status`) => `Error` | The plugin's `api.hap.HapStatusError`, typed by its constructor shape so a plugin's own status-error double fits it as readily as the HAP class does. The type describes the constructor and not what it does with what it is handed, so a class that ignores the status satisfies it too...the tests assert the status a refusal carries rather than only the class it is an instance of. |
| <a id="status"></a> `status?` | `readonly` | `HAPStatus` | The HAP status a refusal carries. Defaults to `HAPStatus.SERVICE_COMMUNICATION_FAILURE`, the status HomeKit renders as Not Responding, so a consumer names one only when it means a different status. |
| <a id="unavailable"></a> `unavailable` | `readonly` | () => `boolean` | The plugin's own availability composition, answering `true` while the device cannot be reached. It is read on each wrapped call rather than captured when the wrapper is built: a device that goes offline refuses the very next call, and one that comes back answers it. |

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
| <a id="service-1"></a> `service` | `readonly` | `Service` | The service the characteristic lives on. |

***

### ValidCharacteristicOptions

The inputs [validCharacteristic](#validcharacteristic) reconciles one characteristic's presence from: the characteristic itself, the service it lives on, and the verdict
that decides whether it should exist.

#### Properties

| Property | Modifier | Type | Description |
| ------ | ------ | ------ | ------ |
| <a id="characteristic-1"></a> `characteristic` | `readonly` | [`CharacteristicTarget`](#characteristictarget) | The characteristic whose presence on the service follows the verdict. |
| <a id="service-2"></a> `service` | `readonly` | `Service` | The service the characteristic lives on. |
| <a id="validate"></a> `validate` | `readonly` | `boolean` \| ((`hasCharacteristic`) => `boolean`) | A boolean, or a predicate handed the characteristic's current presence and answering whether it should exist. |

***

### ValidServiceOptions

The inputs [validService](#validservice) reconciles a service's presence from: everything [acquireService](#acquireservice) needs to create the service when the verdict
says it should exist, plus the verdict itself.

#### Extends

- [`AcquireServiceOptions`](#acquireserviceoptions)\<`T`\>

#### Type Parameters

| Type Parameter | Default type | Description |
| ------ | ------ | ------ |
| <a id="type-parameter-t-3"></a> `T` *extends* `Service` | `Service` | The concrete Service subclass being reconciled. Inferred from `serviceType` so callers receive the specific subclass type back. |

#### Properties

| Property | Modifier | Type | Description | Inherited from |
| ------ | ------ | ------ | ------ | ------ |
| <a id="accessory-2"></a> `accessory` | `readonly` | `PlatformAccessory` | The Homebridge accessory to check or modify. | [`AcquireServiceOptions`](#acquireserviceoptions).[`accessory`](#accessory) |
| <a id="name-1"></a> `name` | `readonly` | `string` | Name to be displayed to the end user for this service. | [`AcquireServiceOptions`](#acquireserviceoptions).[`name`](#name) |
| <a id="onservicecreate-1"></a> `onServiceCreate?` | `readonly` | (`svc`) => `void` | Optional callback invoked only when a new service is created, receiving the new service as its argument. | [`AcquireServiceOptions`](#acquireserviceoptions).[`onServiceCreate`](#onservicecreate) |
| <a id="servicetype-2"></a> `serviceType` | `readonly` | [`AcquireServiceTarget`](#acquireservicetarget)\<`T`\> | The type of service to instantiate or retrieve. Must be a HAP Service subclass with the standard `(displayName?, subtype?)` constructor; see [AcquireServiceTarget](#acquireservicetarget). | [`AcquireServiceOptions`](#acquireserviceoptions).[`serviceType`](#servicetype) |
| <a id="subtype-2"></a> `subtype?` | `readonly` | `string` | Optional service subtype to uniquely identify the service. | [`AcquireServiceOptions`](#acquireserviceoptions).[`subtype`](#subtype) |
| <a id="validate-1"></a> `validate` | `readonly` | `boolean` \| ((`hasService`) => `boolean`) | A boolean, or a predicate handed the service's current presence and answering whether it should exist. The predicate form is a synchronous verdict only: it neither adds nor removes the service itself, and the presence it is handed is the presence [acquireService](#acquireservice) then reads when the verdict says the service should exist. | - |

***

### AcquireServiceTarget

```ts
type AcquireServiceTarget<T> = WithUUID<typeof Service> & (new (displayName?, subtype?) => T);
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
| <a id="type-parameter-t-4"></a> `T` *extends* `Service` | `Service` | The concrete Service subclass produced by the constructor. Inferred from the call site so callers receive the specific subclass type back. |

***

### CharacteristicHandlerAnswer

```ts
type CharacteristicHandlerAnswer = ReturnType<CharacteristicSetHandler>;
```

The answer HAP's set handler contract carries, and the bound [notResponding](#notresponding) holds a wrapped handler's answer to: a nullable characteristic value or
nothing, answered directly or through a promise. It contains every answer a get handler may give, so it is the one bound that admits every handler HAP defines,
and it is read from HAP's own type so HAP stays the source of truth for it.

***

### CharacteristicTarget

```ts
type CharacteristicTarget = WithUUID<typeof Characteristic> & (new () => Characteristic);
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

### PresenceTransition

```ts
type PresenceTransition = "absent" | "attached" | "kept" | "removed";
```

The transition a presence gate performed on one call: `attached` when the call put the characteristic on the service, `kept` when the service already carried
it and keeps it, `removed` when the service carried it and the verdict took it off, and `absent` when the service did not carry it and none was attached.
Presence afterward is `attached` or `kept`, so a consumer reads the presence and the transition that produced it from one answer.

***

### ValidServiceResult

```ts
type ValidServiceResult<T> = 
  | AcquireServiceResult<T>
  | {
  service: null;
  transition: Exclude<PresenceTransition, "attached" | "kept">;
};
```

The service [validService](#validservice) answers, and the transition it performed to answer it: `"attached"` or `"kept"` pair a live service - the present arm
[AcquireServiceResult](#acquireserviceresult) already declares, reused here rather than restated - and `"removed"` or `"absent"` pair `null`, since neither transition
leaves a service behind to read. Reading `transition` narrows `service`: a check against `"attached"` or `"kept"` types it as `T`, and a check against
`"removed"` or `"absent"` types it as `null`.

#### Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| <a id="type-parameter-t-5"></a> `T` *extends* `Service` | `Service` |

***

### acquireService()

```ts
function acquireService<T>(options): AcquireServiceResult<T>;
```

Reconciles a service's presence on an accessory in one call: creates it when it does not exist, or returns it unchanged when it does. Optionally
executes a callback to initialize a newly created service. For a newly created service, the various name characteristics are also set to the
specified name and added where necessary; re-acquiring an existing service returns it with its name characteristics untouched.

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| <a id="type-parameter-t-6"></a> `T` *extends* `Service` | The concrete Service subclass being acquired. Inferred from `serviceType` so callers receive the specific subclass type back rather than the wider `Service` type. |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`AcquireServiceOptions`](#acquireserviceoptions)\<`T`\> | The accessory, the display name, the service type, an optional subtype, and an optional creation callback. See [AcquireServiceOptions](#acquireserviceoptions). |

#### Returns

[`AcquireServiceResult`](#acquireserviceresult)\<`T`\>

The service and the transition this call performed to answer it - `"attached"` when this call created the service, `"kept"` when it already
existed. See [AcquireServiceResult](#acquireserviceresult). Construction failures throw rather than answering a result.

#### Remarks

This method ensures that a newly created service's display name and available name characteristics are updated to the specified name; re-acquiring an
existing service leaves its name characteristics untouched, so a caller renaming an existing service calls [setServiceName](#setservicename) directly. If
`onServiceCreate` is provided, it will only be called for newly created services, not for existing ones.

A call without a subtype on an accessory that already carries subtyped services of the type creates the subtype-less service beside them. HAP refuses a
subtype-less service while any service of its type is on the accessory, yet accepts the same end state built in the other order, so the call makes room: it
detaches the subtyped siblings, adds the new service, re-adds the same sibling instances, and restores every link list that named a sibling to its exact prior
contents and order. When the new service cannot be added, including when HAP's service limit leaves no room for the siblings to follow it, the siblings and
their links are restored before the error propagates, leaving the accessory as it was. `onServiceCreate` runs once the new service and every sibling are on
the accessory.

HomeKit keys a service's identity on its accessory, type, and subtype rather than on the object, so a re-added sibling keeps its instance ids, name,
characteristics, and characteristic handlers, and the automations that reference it survive. The accessory's `primaryService` re-derives itself from a
sibling's primary flag as the sibling is re-added. HAP's `removeService` clears every listener on the Service it detaches and re-installs only its own on the
way back, so a listener a plugin attached directly to a sibling Service's own event emitter is lost and has to be attached again. `PlatformAccessory.addService`
and `removeService` forward straight to the HAP accessory, so all of this holds for a platform accessory as it does for a bare HAP one.

The `ConfiguredName` and `Name` characteristics are conditionally added or updated based on the type of service, in accordance with HomeKit requirements.

#### Example

```typescript
// Ensure a Lightbulb service exists with a user-friendly name, and initialize it if newly created. The return narrows to `Lightbulb`, so callers
// invoke subclass-specific behavior on the result without casts.
const { service: lightbulbService } = acquireService({ accessory, name: "Living Room Lamp", onServiceCreate: (svc): void => {

  // Called only if the service is newly created. `svc` is typed as `Lightbulb` here.
  svc.setCharacteristic(hap.Characteristic.On, false);
}, serviceType: hap.Service.Lightbulb });

// Service is now available, with display name set and optional characteristics managed.
lightbulbService.updateCharacteristic(hap.Characteristic.Brightness, 75);

// Read whether this call created the service from the result, instead of threading a separate flag through onServiceCreate.
const { service: switchService, transition } = acquireService({ accessory, name: "Suspend All Zones", serviceType: hap.Service.Switch });
const isNewSwitch = transition === "attached";
```

#### See

 - setServiceName - updates the newly created (or existing) service's name-related characteristics.
 - validService - reconciles a service's presence from a verdict, creating through this function when the verdict says it should exist.

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
validService({ accessory, name: "Switch", serviceType: Service.Switch,
  validate: capabilityGate({ capability: deviceReportsFeature, toggle: config.enableSwitch }) });
```

#### See

 - validService - consumes the returned predicate.
 - validCharacteristic - consumes the returned predicate for one characteristic on a service.
 - updatePresenceCharacteristic - the same asymmetry, applied to one characteristic's presence on a service.

***

### findService()

```ts
function findService<T>(options): T | undefined;
```

Finds the service [acquireService](#acquireservice) would create for the same type and subtype, and nothing else. A service matches when it carries the type's UUID and
the same subtype, where an empty subtype and no subtype are one identity, as they are in HAP's own service identity. A lookup without a subtype therefore never
answers a subtyped sibling of the same type. HAP's `getService` matches by type alone and ignores the subtype, which is why this module owns the lookup rather
than delegating it.

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| <a id="type-parameter-t-7"></a> `T` *extends* `Service` | The concrete Service subclass being looked up. Inferred from `serviceType` so callers receive the specific subclass type back. |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`FindServiceOptions`](#findserviceoptions)\<`T`\> | The accessory, the service type, and an optional subtype. See [FindServiceOptions](#findserviceoptions). |

#### Returns

`T` \| `undefined`

The matching service, or `undefined` when the accessory carries none.

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
function notResponding(options): <A, T>(handler) => (...args) => T;
```

Binds a device's Not Responding rule once and returns a wrapper that makes any characteristic handler refuse a read or a write while the device is unavailable.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`NotRespondingOptions`](#notrespondingoptions) | The error class, the status, and the availability predicate every wrapped call consults. See [NotRespondingOptions](#notrespondingoptions). |

#### Returns

A wrapper that takes any characteristic handler HAP defines - a get handler or a set handler, synchronous or asynchronous - and returns a handler of the
         same shape, throwing while `unavailable()` is true and passing every argument through to the wrapped handler otherwise.

\<`A`, `T`\>(`handler`) => (...`args`) => `T`

#### Remarks

HomeKit renders a get handler that throws a HAP status error as Not Responding and a set handler that throws one as a failed write, because HAP's set-request
path catches a `HapStatusError` and surfaces its status as the write's result. Whatever a handler answers or accepts, HomeKit renders as fact, so a characteristic
wired around this rule answers a stale value, or accepts a write it cannot deliver, while its device cannot be reached, which is the dishonest display the rule
exists to avoid...wiring every characteristic handler through the wrapper leaves exactly one place that decides whether the device can answer at all.

The wrapper refuses before the handler runs, so a write never reaches a device that cannot be reached and a read never answers a stale value. The refusal is a
synchronous throw for an asynchronous handler too, since the wrapper decides before it calls, and HAP catches a synchronous throw and a rejection alike. While the
device is available, every argument passes through to the handler unchanged and the handler's answer comes back as it gave it.

The error class is injected rather than imported because this library holds `homebridge` and `@homebridge/hap-nodejs` as development dependencies alone and
carries no HAP dependency at runtime: `HapStatusError` reaches a plugin as a member of the runtime `api.hap` namespace, and the plugin is the only holder of it.
The class, the status, and the predicate are facts about a device, while a handler is a fact about one characteristic, so the two bind at different moments - the
device binds the rule once, then wraps each handler as it wires it.

#### Example

```typescript
// Bind the rule once, where the device composes its own availability.
this.answering = notResponding({ errorClass: api.hap.HapStatusError, unavailable: () => this.offline || this.unreachable });

// Wire a characteristic's reads through it. The get handler answers while the device is reachable, and never runs while it is not.
service.getCharacteristic(Characteristic.On).onGet(this.answering(() => this.active));

// Wire its writes through the same binding. The set handler runs while the device is reachable, and the write fails while it is not.
service.getCharacteristic(Characteristic.On).onSet(this.answering((value) => this.setActive(value)));
```

#### See

capabilityGate - the same bind-once shape, applied to whether a service should exist at all.

***

### presenceChanged()

```ts
function presenceChanged(transition): boolean;
```

Answer whether a presence gate changed what HAP serializes for the service, the question a persistence save keys on: `attached` and `removed` put something on
or took something off, so the accessory cache holds a stale copy until it is saved, while `kept` and `absent` left the service as the gate found it.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `transition` | [`PresenceTransition`](#presencetransition) | The transition a presence gate answered. See [PresenceTransition](#presencetransition). |

#### Returns

`boolean`

`true` for `"attached"` and `"removed"`, and `false` for `"kept"` and `"absent"`.

#### Remarks

A plugin that saves through [AccessoryPersistence](accessory-persistence.md#accessorypersistence) marks the accessory wherever a gate's answer reads `true`
here, so every gate reaches the save through one spelling of the check rather than a comparison against the transition's literals at each call site.

#### Example

```typescript
// Save the accessory when the gate attached or removed the characteristic, and leave the cache alone when it kept or never had it.
if(presenceChanged(validCharacteristic({ characteristic: Characteristic.StatusTampered, service, validate: tamperEnabled }))) {

  this.platform.persistence.persist(accessory);
}
```

***

### setAccessoryName()

```ts
function setAccessoryName(accessory, name): boolean;
```

Updates the display name of an accessory and of its AccessoryInformation service to the specified value.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `accessory` | `PlatformAccessory` | The accessory to rename. |
| `name` | `string` | The new name to apply to the accessory. |

#### Returns

`boolean`

True when the call wrote anything, a display name or a characteristic, and false when every name already carried the sanitized name or nothing was
left after sanitizing.

#### Remarks

An accessory carries its name in more than one place, and a rename that reaches only some of them leaves the accessory answering to two names. This writes all
of them from one sanitized source, then hands each pair to whichever API owns it: Homebridge's `updateDisplayName` owns the accessory display names (the
`PlatformAccessory`'s own and the HAP accessory's beneath it), and [setServiceName](#setservicename) owns the AccessoryInformation service's `ConfiguredName` and `Name`
characteristics. `ConfiguredName` is what makes a rename stick in the Home app, since it is the name a user can edit there, so whether to sync a device's name
at all stays the plugin's policy: a call with the device's name replaces a name the user gave the accessory.

Each name is compared before it is written, and only what differs is written, so a plugin calls this on every refresh of a device's name and saves the accessory
only when the answer is true, with no comparison of its own. A comparison of its own would misread a fresh accessory: HAP seeds the information service's `Name`
with the display name, so a fresh accessory already reads as named while it still lacks the `ConfiguredName` this adds.

The name is sanitized through the same HomeKit naming rules [acquireService](#acquireservice) applies, so a caller may pass a raw device name straight through. A name with
nothing left after sanitizing is not applied anywhere: an accessory has to answer to something, and a blank one is worse than the name it already had.

#### Example

```typescript
// Rename an accessory after the device reports a new name, and save it to Homebridge's accessory cache only when the rename changed something.
if(setAccessoryName(accessory, device.name)) {

  this.platform.persistence.persist(accessory);
}
```

#### See

 - setServiceName - the per-service equivalent this delegates its characteristic writes to.
 - getServiceName - to retrieve the current name set on a service.

***

### setServiceName()

```ts
function setServiceName(service, name): boolean;
```

Updates the displayName and applicable name characteristics of a service to the specified value.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `service` | `Service` | The service to update. |
| `name` | `string` | The new name to apply to the service. |

#### Returns

`boolean`

True when the call wrote anything, the display name or a characteristic, and false when each already carried the sanitized name or nothing was left
after sanitizing.

#### Remarks

This function ensures the name is validated, then compares the service's `displayName`, and its `ConfiguredName` and `Name` characteristics, against it, writing
only those that differ. A name characteristic the service carries is kept in step whatever the service's kind, and one it lacks is added where the kind supports
it, registered first as one of the service's optional characteristics, so HAP adds it without a warning, on a service restored from the accessory cache too.
Each characteristic's presence is read before its value, because HAP's `getCharacteristic` attaches whatever it is asked for, so a missing one is always added
as a reported write rather than silently by the read, and one the kind does not support is never added at all. A plugin calls this on every refresh of a name and
saves the accessory only when the answer is true, with no comparison of its own. Whether to sync a device's name at all stays the plugin's policy, because
`ConfiguredName` is a name a controller can write, so a call with the device's name replaces a name the user gave the service.

HAP cuts a name characteristic's value past the characteristic's maximum length, its own `maxLen` or HAP's default for a string, so each characteristic is
written and compared in that cut form, with any end HomeKit's naming rule forbids stripped from the cut...a long name is written once, with no warning from HAP,
and reads as unchanged afterward. The display name carries the whole name.

A name with nothing left after sanitizing is not applied, as [setAccessoryName](#setaccessoryname) refuses one: a service has to answer to something, and a blank name is worse
than the one it already carries.

#### Example

```typescript
// Rename a service after the device reports a new name for it, and save the accessory only when the rename changed something.
if(setServiceName(service, zone.name)) {

  this.platform.persistence.persist(accessory);
}
```

#### See

 - acquireService - to add or retrieve services.
 - getServiceName - to retrieve the current name set on a service.
 - setAccessoryName - the accessory-level equivalent, which delegates its information-service write here.

***

### updatePresenceCharacteristic()

```ts
function updatePresenceCharacteristic(options): PresenceTransition;
```

Reconcile one characteristic's presence on a service against the reading behind it, applying the same additive-eager / subtractive-conservative asymmetry
[capabilityGate](#capabilitygate) applies to services, one level down.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`PresenceCharacteristicOptions`](#presencecharacteristicoptions) | The characteristic, its service, the read-through behind it, and the device's reachability. See [PresenceCharacteristicOptions](#presencecharacteristicoptions). |

#### Returns

[`PresenceTransition`](#presencetransition)

The transition the call performed: `"attached"` or `"kept"` on a reported reading, `"kept"` or `"absent"` on a hold, and `"removed"` or `"absent"` on an
absent reading from a reachable device. The characteristic is present afterward when the answer is `"attached"` or `"kept"`, and [presenceChanged](#presencechanged) answers
whether the call changed what HAP serializes. See [PresenceTransition](#presencetransition).

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
const transition = updatePresenceCharacteristic({ characteristic: Characteristic.PM2_5Density, reachable: this.isReachable,
  read: () => toReading(this.metric), service });

// An attach or a removal changed what the accessory cache holds, so the accessory is marked for a save.
if(presenceChanged(transition)) {

  this.platform.persistence.persist(this.accessory);
}
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
function validCharacteristic(options): PresenceTransition;
```

Validate whether a specific characteristic should exist on the given service, attaching it when it should and removing it when it should not.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`ValidCharacteristicOptions`](#validcharacteristicoptions) | The characteristic, the service it lives on, and the verdict that decides its presence. See [ValidCharacteristicOptions](#validcharacteristicoptions). |

#### Returns

[`PresenceTransition`](#presencetransition)

The transition the call performed - `"attached"`, `"kept"`, `"removed"`, or `"absent"`; the characteristic is present afterward when the answer
is `"attached"` or `"kept"`.

#### Remarks

The `validate` parameter can be either:
  - a boolean (where `true` means the characteristic should exist, `false` means remove it).
  - a function (which is called with `hasCharacteristic: boolean` and returns whether the characteristic should exist).

Presence is read without attaching, so a characteristic the service never carried is never materialized only to be removed. A true verdict attaches through
the service's own lookup, which adds an optional characteristic the service lacks and answers the existing one otherwise...the answer names which of the
four transitions happened, so a consumer that must act exactly once on the attach reads that from the answer. The helper is meant for a characteristic the
service declares optional. HAP attaches a characteristic outside a service's declared sets too, with a warning, and nothing here guards against that.

#### Example

```typescript
// Attach the characteristic while a configuration fact holds, and remove it otherwise.
validCharacteristic({ characteristic: Characteristic.StatusFault, service, validate: hasCredentials });

// Keep the characteristic if the service already carries it, or add it when the user asks for it.
validCharacteristic({ characteristic: Characteristic.StatusTampered, service, validate: (has) => has || config.showTamper });

// Gate the characteristic on a hardware capability and a user toggle.
validCharacteristic({ characteristic: Characteristic.StatusTampered, service,
  validate: capabilityGate({ capability: device.reportsTamper, toggle: config.tamperDetection }) });

// Act exactly once when the characteristic first appears: write the verdict held for it.
if(validCharacteristic({ characteristic: Characteristic.StatusTampered, service, validate: tamperEnabled }) === "attached") {

  service.updateCharacteristic(Characteristic.StatusTampered, heldTamperState);
}
```

#### See

 - validService - the same contract, applied to whether a service should exist on an accessory, its answer carrying the service alongside the transition.
 - capabilityGate - builds a predicate for either applier.

***

### validService()

```ts
function validService<T>(options): ValidServiceResult<T>;
```

Reconciles a service's presence on the given accessory from one verdict: creates it through [acquireService](#acquireservice) when the verdict says it should
exist and it does not, removes it when the verdict says it should not and it does, and leaves it alone otherwise.

#### Type Parameters

| Type Parameter | Description |
| ------ | ------ |
| <a id="type-parameter-t-8"></a> `T` *extends* `Service` | The concrete Service subclass being reconciled. Inferred from `serviceType` so callers receive the specific subclass type back. |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`ValidServiceOptions`](#validserviceoptions)\<`T`\> | The accessory, the service type, the display name and optional creation callback [acquireService](#acquireservice) uses on a creating verdict, an optional subtype, and the verdict that decides the service's presence. See [ValidServiceOptions](#validserviceoptions). |

#### Returns

[`ValidServiceResult`](#validserviceresult)\<`T`\>

The service and the transition this call performed - `"attached"` or `"kept"` pair the service, `"removed"` or `"absent"` pair `null`. See
[ValidServiceResult](#validserviceresult).

#### Remarks

The `validate` parameter can be either:
  - a boolean (where `true` means the service should exist, `false` means remove it).
  - a function (which is called with `hasService: boolean` and returns whether the service should exist).

A true verdict on an absent service is answered by [acquireService](#acquireservice), so creation exists in exactly one place in this module.

#### Example

```typescript
// Remove a service if it exists.
validService({ accessory, name: "Switch", serviceType: Service.Switch, validate: false });

// Only keep a service if a configuration flag is true, creating it when the flag says it should exist.
validService({ accessory, name: "Switch", serviceType: Service.Switch, validate: config.enableSwitch });

// Keep a service if it currently exists, or add it if a certain condition is met. A true verdict on an absent service creates it through
// acquireService, so `service` reads the live instance either way.
const { service } = validService({ accessory, name: "Switch", serviceType: Service.Switch,
  validate: (hasService) => hasService || config.enableSwitch });

// `transition` narrows `service`: an "attached" or "kept" transition types it as the service, and a "removed" or "absent" transition types it as
// `null`.
const result = validService({ accessory, name: "Switch", serviceType: Service.Switch, validate: config.enableSwitch });

if((result.transition === "attached") || (result.transition === "kept")) {

  result.service.updateCharacteristic(Characteristic.On, false);
}
```

#### See

 - acquireService - the creation this function delegates to on a verdict that should exist.
 - validCharacteristic - the same contract, applied to one characteristic's presence on a service.
