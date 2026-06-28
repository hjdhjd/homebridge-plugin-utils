/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * homebridge-enums.ts: Single source of truth for the homebridge-core const enum mirrors that plugins need at runtime.
 */

/**
 * Mirrors homebridge-core const enum values that plugins need at value-side runtime. `verbatimModuleSyntax` disallows value imports of ambient const enums, so the
 * string contracts from homebridge's `api.d.ts` are re-declared here at value-side. This is the homebridge-core counterpart of the HAP mirrors in `ffmpeg/hap-enums.ts`:
 * every Homebridge plugin registers for the `api` lifecycle events, so centralizing the mirror gives every consumer a single import path and a single update point if
 * upstream `homebridge` ever changes a value.
 *
 * Values MUST stay in lockstep with the upstream definitions in `homebridge/.../api.d.ts`. The matching type alias lets consumers import the canonical name from one
 * place rather than re-declaring it.
 *
 * @module
 */
import type { APIEvent as APIEventEnum } from "homebridge";

/**
 * String mirror of homebridge-core's `APIEvent` const enum, surfaced to plugins for `api.on(...)` lifecycle-event registration: `DID_FINISH_LAUNCHING` fires once
 * homebridge has finished booting and initializing every plugin, and `SHUTDOWN` fires when homebridge shuts down (a regular shutdown or an unexpected crash).
 *
 * @category Homebridge
 */
export const APIEvent: { readonly DID_FINISH_LAUNCHING: APIEventEnum.DID_FINISH_LAUNCHING; readonly SHUTDOWN: APIEventEnum.SHUTDOWN } = {

  // String const enum members are nominal in TypeScript: a raw string literal is not assignable to the enum member type without an explicit brand. The per-property
  // assertions make the intent visible at each value, and the assertion fails fast if the upstream string ever changes out from under us.
  DID_FINISH_LAUNCHING: "didFinishLaunching" as APIEventEnum.DID_FINISH_LAUNCHING,
  SHUTDOWN: "shutdown" as APIEventEnum.SHUTDOWN
};

/**
 * Type alias re-exposing the homebridge enum under its canonical name so existing `event: APIEvent` annotations resolve through the shared module rather than a local
 * redeclaration in each consumer.
 *
 * @category Homebridge
 */
export type APIEvent = APIEventEnum;
