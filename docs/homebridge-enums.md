[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / homebridge-enums

# homebridge-enums

Mirrors the const enum values every Homebridge plugin needs at value-side runtime, sourced from the "homebridge" module surface: `APIEvent` from homebridge-core's
`api.d.ts`, and `Categories` from hap-nodejs's `Accessory.d.ts` and `HAPStatus` from its `HAPServer.d.ts` as "homebridge" re-exports them. `verbatimModuleSyntax`
disallows value imports of ambient const enums, so those contracts are re-declared here at value-side. This is the plugin-facing counterpart of the camera-protocol
mirrors in `ffmpeg/hap-enums.ts`: every plugin registers for the `api` lifecycle events, any plugin that registers an accessory names its category, and any plugin
that reports a device fault to HomeKit names a status code, so centralizing the mirrors gives every consumer a single import path and a single update point.

Each mirror is annotated with a type derived from the upstream declaration itself, so the compiler enforces lockstep: a member added, removed, or revalued upstream
fails the build here until the mirror is updated. The matching type aliases let consumers import the canonical names from one place rather than re-declaring them.

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

### HAPStatus

```ts
type HAPStatus = HAPStatusEnum;
```

Type alias re-exposing the HAP enum under its canonical name so existing `status: HAPStatus` annotations resolve through the shared module rather than a local
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

### HAPStatus

```ts
const HAPStatus: Readonly<typeof HAPStatusEnum>;
```

Numeric mirror of HAP's `HAPStatus` const enum: the status codes a characteristic read or write answers with. A plugin that cannot serve a request surfaces the fault
to HomeKit by throwing a status error carrying one of these codes, and `SERVICE_COMMUNICATION_FAILURE` is the workhorse of the set - it is the code that renders an
accessory as not responding in the Home app while the device is unreachable.
