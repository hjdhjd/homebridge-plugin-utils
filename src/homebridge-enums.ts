/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * homebridge-enums.ts: Single source of truth for the const enum mirrors that every Homebridge plugin needs at runtime.
 */

/**
 * Mirrors the const enum values every Homebridge plugin needs at value-side runtime, sourced from the "homebridge" module surface: `APIEvent` from homebridge-core's
 * `api.d.ts`, and `Categories` from hap-nodejs's `Accessory.d.ts` and `HAPStatus` from its `HAPServer.d.ts` as "homebridge" re-exports them. `verbatimModuleSyntax`
 * disallows value imports of ambient const enums, so those contracts are re-declared here at value-side. This is the plugin-facing counterpart of the camera-protocol
 * mirrors in `ffmpeg/hap-enums.ts`: every plugin registers for the `api` lifecycle events, any plugin that registers an accessory names its category, and any plugin
 * that reports a device fault to HomeKit names a status code, so centralizing the mirrors gives every consumer a single import path and a single update point.
 *
 * Each mirror is annotated with a type derived from the upstream declaration itself, so the compiler enforces lockstep: a member added, removed, or revalued upstream
 * fails the build here until the mirror is updated. The matching type aliases let consumers import the canonical names from one place rather than re-declaring them.
 *
 * @module
 */
import type { APIEvent as APIEventEnum, Categories as CategoriesEnum, HAPStatus as HAPStatusEnum } from "homebridge";

/**
 * String mirror of homebridge-core's `APIEvent` const enum, surfaced to plugins for `api.on(...)` lifecycle-event registration: `DID_FINISH_LAUNCHING` fires once
 * homebridge has finished booting and initializing every plugin, and `SHUTDOWN` fires when homebridge shuts down (a regular shutdown or an unexpected crash).
 *
 * @category Homebridge
 */
export const APIEvent: Readonly<typeof APIEventEnum> = {

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

/**
 * Numeric mirror of HAP's `Categories` const enum: the accessory-category hint a plugin supplies when it registers an accessory, which iOS clients read to decide how
 * to present it. Surfaced so plugins assign a typed category value by name rather than a bare numeric.
 *
 * @category Homebridge
 */
// The `Readonly<typeof CategoriesEnum>` annotation derives the required shape from hap-nodejs's own declaration, so a missing member, an extra member, or a value
// that drifts from upstream is a compile error here and the mirror cannot silently drift. Upstream declares HAP-naming aliases that share a value with the member
// they alias, and they are mirrored exactly as upstream declares them.
export const Categories: Readonly<typeof CategoriesEnum> = {

  AIRPORT: 27, AIR_CONDITIONER: 21, AIR_DEHUMIDIFIER: 23, AIR_HEATER: 20, AIR_HUMIDIFIER: 22, AIR_PURIFIER: 19, ALARM_SYSTEM: 11, APPLE_TV: 24, AUDIO_RECEIVER: 34,
  BRIDGE: 2, CAMERA: 17, DOOR: 12, DOOR_LOCK: 6, FAN: 3, FAUCET: 29, GARAGE_DOOR_OPENER: 4, HOMEPOD: 25, IP_CAMERA: 17, LIGHTBULB: 5, OTHER: 1, OUTLET: 7,
  PROGRAMMABLE_SWITCH: 15, RANGE_EXTENDER: 16, ROUTER: 33, SECURITY_SYSTEM: 11, SENSOR: 10, SHOWER_HEAD: 30, SPEAKER: 26, SPRINKLER: 28, SWITCH: 8,
  TARGET_CONTROLLER: 32, TELEVISION: 31, THERMOSTAT: 9, TV_SET_TOP_BOX: 35, TV_STREAMING_STICK: 36, VIDEO_DOORBELL: 18, WINDOW: 13, WINDOW_COVERING: 14
};

/**
 * Type alias re-exposing the HAP enum under its canonical name so existing `category: Categories` annotations resolve through the shared module rather than a local
 * redeclaration in each consumer.
 *
 * @category Homebridge
 */
export type Categories = CategoriesEnum;

/**
 * Numeric mirror of HAP's `HAPStatus` const enum: the status codes a characteristic read or write answers with. A plugin that cannot serve a request surfaces the fault
 * to HomeKit by throwing a status error carrying one of these codes, and `SERVICE_COMMUNICATION_FAILURE` is the workhorse of the set - it is the code that renders an
 * accessory as not responding in the Home app while the device is unreachable.
 *
 * @category Homebridge
 */
// The `Readonly<typeof HAPStatusEnum>` annotation derives the required shape from hap-nodejs's own declaration, so a missing member, an extra member, or a value that
// drifts from upstream is a compile error here and the mirror cannot silently drift.
export const HAPStatus: Readonly<typeof HAPStatusEnum> = {

  INSUFFICIENT_AUTHORIZATION: -70411, INSUFFICIENT_PRIVILEGES: -70401, INVALID_VALUE_IN_REQUEST: -70410, NOTIFICATION_NOT_SUPPORTED: -70406,
  NOT_ALLOWED_IN_CURRENT_STATE: -70412, OPERATION_TIMED_OUT: -70408, OUT_OF_RESOURCE: -70407, READ_ONLY_CHARACTERISTIC: -70404, RESOURCE_BUSY: -70403,
  RESOURCE_DOES_NOT_EXIST: -70409, SERVICE_COMMUNICATION_FAILURE: -70402, SUCCESS: 0, WRITE_ONLY_CHARACTERISTIC: -70405
};

/**
 * Type alias re-exposing the HAP enum under its canonical name so existing `status: HAPStatus` annotations resolve through the shared module rather than a local
 * redeclaration in each consumer.
 *
 * @category Homebridge
 */
export type HAPStatus = HAPStatusEnum;
