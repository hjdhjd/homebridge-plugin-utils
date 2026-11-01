[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / homebridge-enums

# homebridge-enums

Mirrors the const enum values every Homebridge plugin needs at value-side runtime, sourced from the "homebridge" module surface: `APIEvent` from homebridge-core's
`api.d.ts`, and `Categories` from hap-nodejs's `Accessory.d.ts`, `HAPStatus` from its `HAPServer.d.ts`, `ChangeReason` and `Perms` from its `Characteristic.d.ts`
and `ServiceEventTypes` from its `Service.d.ts` as "homebridge" re-exports them. `CharacteristicWarningType`, from hap-nodejs's `Accessory.d.ts`, is the one
"homebridge" does not re-export, so it is sourced from hap-nodejs directly. `verbatimModuleSyntax` disallows value imports of ambient const enums, so those
contracts are re-declared here at value-side. This is the plugin-facing counterpart of the camera-protocol mirrors in `ffmpeg/hap-enums.ts`: every plugin
registers for the `api` lifecycle events, any plugin that registers an accessory names its category, any plugin that reports a device fault to HomeKit names a
status code, any plugin that selects an accessory's characteristics by permission names the flag it selects on, any code that listens on a service names the
event it listens for and the reason a characteristic changed, and a plugin's suite that reads the warnings HAP raises names the kind it reads, so centralizing
the mirrors gives every consumer a single import path and a single update point.

Each mirror is annotated with a type derived from the upstream declaration itself, so the compiler enforces lockstep: a member added or removed upstream fails the
build here until the mirror is updated. A member revalued upstream fails it as well, a numeric mirror's through that derived type and a string mirror's through the
`satisfies` check each of its values passes before it is branded, because the `as` assertion that brands a string as its enum member accepts any string. The
matching type aliases let consumers import the canonical names from one place rather than re-declaring them.

## Homebridge

### APIEvent

```ts
type APIEvent = APIEventEnum;
```

Type alias re-exposing the homebridge enum under its canonical name so existing `event: APIEvent` annotations resolve through the shared module rather than a local
redeclaration in each consumer.

***

### Categories

```ts
type Categories = CategoriesEnum;
```

Type alias re-exposing the HAP enum under its canonical name so existing `category: Categories` annotations resolve through the shared module rather than a local
redeclaration in each consumer.

***

### ChangeReason

```ts
type ChangeReason = ChangeReasonEnum;
```

Type alias re-exposing the HAP enum under its canonical name so a `reason: ChangeReason` annotation resolves through the shared module rather than a local
redeclaration in each consumer.

***

### CharacteristicWarningType

```ts
type CharacteristicWarningType = CharacteristicWarningTypeEnum;
```

Type alias re-exposing the HAP enum under its canonical name so a `type: CharacteristicWarningType` annotation resolves through the shared module rather than a
local redeclaration in each consumer.

***

### HAPStatus

```ts
type HAPStatus = HAPStatusEnum;
```

Type alias re-exposing the HAP enum under its canonical name so existing `status: HAPStatus` annotations resolve through the shared module rather than a local
redeclaration in each consumer.

***

### Perms

```ts
type Perms = PermsEnum;
```

Type alias re-exposing the HAP enum under its canonical name so existing `perms: Perms[]` annotations resolve through the shared module rather than a local
redeclaration in each consumer.

***

### ServiceEventTypes

```ts
type ServiceEventTypes = ServiceEventTypesEnum;
```

Type alias re-exposing the HAP enum under its canonical name so an `event: ServiceEventTypes` annotation resolves through the shared module rather than a local
redeclaration in each consumer.

***

### APIEvent

```ts
const APIEvent: Readonly<typeof APIEventEnum>;
```

String mirror of homebridge-core's `APIEvent` const enum, surfaced to plugins for `api.on(...)` lifecycle-event registration: `DID_FINISH_LAUNCHING` fires once
homebridge has finished booting and initializing every plugin, and `SHUTDOWN` fires when homebridge shuts down (a regular shutdown or an unexpected crash).

***

### Categories

```ts
const Categories: Readonly<typeof CategoriesEnum>;
```

Numeric mirror of HAP's `Categories` const enum: the accessory-category hint a plugin supplies when it registers an accessory, which iOS clients read to decide how
to present it. Surfaced so plugins assign a typed category value by name rather than a bare numeric.

***

### ChangeReason

```ts
const ChangeReason: Readonly<typeof ChangeReasonEnum>;
```

String mirror of HAP's `ChangeReason` const enum: why a characteristic's value changed, which HAP carries on every change it raises. A controller's write and a
plugin's `setValue` each raise `WRITE`, the controller's carrying the connection it arrived on as the change's originator and the plugin's none, and a plugin's
`updateValue` raises `UPDATE`, so code reacting to a write reads a change's `reason` against `ChangeReason.WRITE` rather than a bare `"write"` literal.

***

### CharacteristicWarningType

```ts
const CharacteristicWarningType: Readonly<typeof CharacteristicWarningTypeEnum>;
```

String mirror of HAP's `CharacteristicWarningType` const enum: the kind HAP attaches to a characteristic warning, which a suite filters the testing entry's
captured warnings by, reading a warning's `type` against `CharacteristicWarningType.ERROR_MESSAGE` rather than a bare `"error-message"` literal.

***

### HAPStatus

```ts
const HAPStatus: Readonly<typeof HAPStatusEnum>;
```

Numeric mirror of HAP's `HAPStatus` const enum: the status codes a characteristic read or write answers with. A plugin that cannot serve a request surfaces the fault
to HomeKit by throwing a status error carrying one of these codes, and `SERVICE_COMMUNICATION_FAILURE` is the workhorse of the set - it is the code that renders an
accessory as not responding in the Home app while the device is unreachable.

***

### Perms

```ts
const Perms: Readonly<typeof PermsEnum>;
```

String mirror of HAP's `Perms` const enum: the permission flags a characteristic declares in its `props.perms`, such as whether a controller may read it, write
it, or subscribe to its change notifications. A plugin that refuses writes while a device is unreachable walks an accessory's characteristics by their write
permission, reading `props.perms` against `Perms.PAIRED_WRITE` rather than a bare `"pw"` literal.

***

### ServiceEventTypes

```ts
const ServiceEventTypes: Readonly<typeof ServiceEventTypesEnum>;
```

String mirror of HAP's `ServiceEventTypes` const enum: the events a service raises, a change to the value of any characteristic it carries among them. Code that
listens on a service names the event it listens for through this mirror, `ServiceEventTypes.CHARACTERISTIC_CHANGE` rather than a bare `"characteristic-change"`
literal, and HAP's listener signatures accept each member as the string it mirrors.
