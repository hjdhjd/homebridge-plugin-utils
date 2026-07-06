[**homebridge-plugin-utils**](README.md)

***

[Home](README.md) / homebridge-enums

# homebridge-enums

Mirrors homebridge-core const enum values that plugins need at value-side runtime. `verbatimModuleSyntax` disallows value imports of ambient const enums, so the
string contracts from homebridge's `api.d.ts` are re-declared here at value-side. This is the homebridge-core counterpart of the HAP mirrors in `ffmpeg/hap-enums.ts`:
every Homebridge plugin registers for the `api` lifecycle events, so centralizing the mirror gives every consumer a single import path and a single update point if
upstream `homebridge` ever changes a value.

Values MUST stay in lockstep with the upstream definitions in `homebridge/.../api.d.ts`. The matching type alias lets consumers import the canonical name from one
place rather than re-declaring it.

## Homebridge

### APIEvent

```ts
type APIEvent = APIEventEnum;
```

Type alias re-exposing the homebridge enum under its canonical name so existing `event: APIEvent` annotations resolve through the shared module rather than a local
redeclaration in each consumer.

***

### APIEvent

```ts
const APIEvent: {
  DID_FINISH_LAUNCHING: APIEventEnum.DID_FINISH_LAUNCHING;
  SHUTDOWN: APIEventEnum.SHUTDOWN;
};
```

String mirror of homebridge-core's `APIEvent` const enum, surfaced to plugins for `api.on(...)` lifecycle-event registration: `DID_FINISH_LAUNCHING` fires once
homebridge has finished booting and initializing every plugin, and `SHUTDOWN` fires when homebridge shuts down (a regular shutdown or an unexpected crash).

#### Type Declaration

| Name | Type |
| ------ | ------ |
| <a id="property-did_finish_launching"></a> `DID_FINISH_LAUNCHING` | `APIEventEnum.DID_FINISH_LAUNCHING` |
| <a id="property-shutdown"></a> `SHUTDOWN` | `APIEventEnum.SHUTDOWN` |
