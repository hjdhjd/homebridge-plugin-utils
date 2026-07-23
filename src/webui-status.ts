/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webui-status.ts: The wire contract for the live device-status webUI panel.
 */

/**
 * The live device-status protocol shared by both sides of the Config UI X bridge.
 *
 * Both bridge sides speak exactly this vocabulary: a plugin's server-side adapter (running inside the transient custom-UI child process Config UI X forks for the
 * settings modal) imports these types and constants from the package root and emits {@link StatusEvent}s under {@link STATUS_EVENT}; the browser-side status panel
 * consumes the same module through the compiled copy the build dual-ships into `dist/ui/`, and reads the untrusted view-request body through
 * {@link narrowStatusViewRequest}. The module is browser-safe by construction - its only import is the `Nullable` type alias, erased at emit - so shipping it
 * alongside the panel drags in nothing Node-only. The panel renderer, the row vocabulary, and the label choices are the consuming plugin's; this module owns only the
 * shape of what crosses the wire.
 *
 * @module
 */
import type { Nullable } from "./util.ts";

/**
 * The push-event name a plugin's status adapter publishes {@link StatusEvent} payloads under, and the browser panel subscribes to. One owner for the literal, shared
 * by both bridge sides.
 *
 * @category WebUI Status
 */
export const STATUS_EVENT = "status";

/**
 * The bridge route the browser panel sends a {@link StatusViewRequest} to when the viewed device changes. Advisory and fire-and-forget: results flow back over
 * {@link STATUS_EVENT} push events, so an adapter may ignore the request entirely.
 *
 * @category WebUI Status
 */
export const STATUS_VIEW_ROUTE = "/statusView";

/**
 * A row's momentary-value latch. A rendered value equal to {@link StatusRowLatch.value} clears back to the placeholder dash after {@link StatusRowLatch.seconds}, a
 * positive finite number of seconds; the panel ignores a non-positive latch. Re-arrival of the same value extends the timer, and a different value cancels it.
 *
 * @category WebUI Status
 */
export interface StatusRowLatch {

  /**
   * The number of seconds the momentary value stays latched before it clears back to the placeholder. A non-positive value disables the latch.
   */
  seconds: number;

  /**
   * The momentary value that arms the latch. Only a rendered value equal to this string starts the clear-back timer.
   */
  value: string;
}

/**
 * A status row's static vocabulary: its identity, its display label, its optional momentary-value latch, and its width reservation. The panel's placeholder
 * configuration speaks templates; the wire speaks full {@link StatusRow}s that add the live value.
 *
 * @category WebUI Status
 */
export interface StatusRowTemplate {

  /**
   * The stable row identity a live {@link StatusEvent} of kind `"row"` addresses to update exactly this row's value in place.
   */
  id: string;

  /**
   * The human-readable row label. The label rides with the snapshot so the panel need not know the row-to-label mapping.
   */
  label: string;

  /**
   * The optional momentary-value latch. Present only for rows whose value is transient (a motion detection, an obstruction pulse).
   */
  latch?: StatusRowLatch;

  /**
   * The widest value the row's vocabulary can produce: a single string, or a non-empty tuple when more than one candidate contends for widest. The panel reserves each
   * candidate as an invisible phantom and takes their maximum, so no font-metrics judgment lives in code. The tuple type forbids an empty reservation by construction.
   */
  sizer: string | [string, ...string[]];
}

/**
 * One rendered status row: a {@link StatusRowTemplate} plus its current display value. Snapshots carry full rows; subsequent `"row"` events carry only the id and the
 * new value.
 *
 * @category WebUI Status
 */
export interface StatusRow extends StatusRowTemplate {

  /**
   * The row's current display value. An empty or blank string renders as the placeholder dash.
   */
  value: string;
}

/**
 * The classified reasons a status feed can fail to render, each mapping to distinct panel copy. Deliberately credential-neutral: `auth-invalid` / `auth-missing`
 * serve a PSK, a password, or a token equally. The vocabulary grows additively in `homebridge-plugin-utils` when an adapter needs a new classification, never as a
 * per-plugin fork.
 *
 * @category WebUI Status
 */
export type StatusErrorReason = "auth-invalid" | "auth-missing" | "not-found" | "timeout" | "unreachable";

/**
 * The bridge event, a discriminated union tagged on `kind`. Every DEVICE event carries the device's `serialNumber` - the sidebar device model's universal identity, the
 * protocol's one identity field - and a monotonic `session` token minted server-side from one only-growing counter per feed. The reading side guards per device on
 * strictly-lower tokens; an adapter MUST drop a superseded session's pushes at the source with a session-identity check before every emit, which is what makes the
 * panel's per-mount guard reset safe. The availability variants pin `encrypted: false` when offline because no transport exists, so an encrypted-but-offline event is
 * unrepresentable.
 *
 * `hello` is the one server-scoped member: a fresh adapter process introduces itself with it, carrying its `generation`, an opaque per-process value whose only contract
 * is uniqueness across that plugin's helper processes. A millisecond boot timestamp is the convenient source; the panel compares generations by equality alone and claims
 * no ordering, so a host clock adjustment or an RTC-less boot cannot wrongly reject a genuine fresh server. The panel adopts an unseen generation by clearing its
 * per-device token floors and notifying the plugin, which is what lets a surviving page recover from a helper restart it cannot otherwise observe. Delivery is advisory
 * like every push: an adapter emits `hello` once at startup, after its bridge is ready, and a plugin-side belt may cover the rare lost delivery. One known bound lives
 * here rather than in machinery - in the brief window where a dying process's late device event lands after a fresh generation's adoption, its high token re-arms a
 * cleared floor; device events carry no generation to attribute them by, the window requires two helper processes' messages to interleave across a handoff, and a
 * per-event generation field remains the additive escape if the field ever reports it.
 *
 * The union grows additively in this library, and `hello`'s field set is itself additive.
 *
 * @category WebUI Status
 */
export type StatusEvent =
  { generation: number; kind: "hello" } |
  { kind: "connecting"; serialNumber: string; session: number } |
  { encrypted: boolean; kind: "snapshot"; online: true; rows: StatusRow[]; serialNumber: string; session: number } |
  { kind: "row"; row: Pick<StatusRow, "id" | "value">; serialNumber: string; session: number } |
  { encrypted: boolean; kind: "availability"; online: true; serialNumber: string; session: number } |
  { encrypted: false; kind: "availability"; online: false; serialNumber: string; session: number } |
  { kind: "error"; reason: StatusErrorReason; serialNumber: string; session: number };

/**
 * The view request the browser panel sends when the viewed device changes. Advisory fire-and-forget: no response body, results flow over push events, and a server may
 * ignore it. The frozen surface is deliberately tiny - the route name, the one required field, the fire-and-forget posture, and the send-on-viewed-device-change
 * trigger - so optional payload fields stay additive.
 *
 * @category WebUI Status
 */
export interface StatusViewRequest {

  /**
   * The device the panel is now viewing, addressed by the same universal `serialNumber` identity every device event carries.
   */
  serialNumber: string;
}

/**
 * Narrow the untrusted view-request body at the bridge boundary. The body must be a non-null object carrying a non-empty string `serialNumber` - any non-string value
 * rejects - or the whole request is null. The narrowed result carries ONLY `serialNumber`, never a passthrough of the input object. This lives in the tested module
 * rather than any plugin's untestable server adapter.
 *
 * @param body - The untrusted bridge request body.
 *
 * @returns The narrowed {@link StatusViewRequest}, or null when the body does not match the contract.
 *
 * @category WebUI Status
 */
export function narrowStatusViewRequest(body: unknown): Nullable<StatusViewRequest> {

  if((typeof body !== "object") || (body === null)) {

    return null;
  }

  const record = body as { serialNumber?: unknown };

  if((typeof record.serialNumber !== "string") || (record.serialNumber.length === 0)) {

    return null;
  }

  return { serialNumber: record.serialNumber };
}
