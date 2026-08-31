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
 * A text row's momentary-value latch. A rendered value equal to {@link StatusRowLatch.value} clears back to the placeholder dash after {@link StatusRowLatch.seconds},
 * a positive finite number of seconds; the panel ignores a non-positive latch. Re-arrival of the same value extends the timer, and a different value cancels it. It is
 * a mechanism of the text form alone - a value is what a latch clears - so the choices form declares none.
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
 * One member of a {@link StatusChoicesRow}'s list: what to call it, and whether it is in effect on the device right now. Display-only in both directions - the panel
 * draws a checked or unchecked box beside the label and offers no way to change it - so `selected` reports the device's state rather than collecting the user's.
 *
 * @category WebUI Status
 */
export interface StatusChoice {

  /**
   * The human-readable choice name, rendered beside its checkbox glyph.
   */
  label: string;

  /**
   * Whether this choice is currently enabled on the device.
   */
  selected: boolean;
}

/**
 * A choices row's static vocabulary: its identity, its tag, and its display label. It declares no width reservation because a choices row already is one - every
 * choice in the list renders at all times and the checkbox glyph is metrically constant, so the rendered list occupies exactly the width it reserves. Replacing the
 * list can still move the panel's column widths, so a composer who wants a panel that never shifts holds the list itself steady and moves only
 * {@link StatusChoice.selected}, the same own-your-width-consequence posture a label override carries.
 *
 * @category WebUI Status
 */
export interface StatusChoicesRowTemplate {

  /**
   * The stable row identity a live {@link StatusEvent} of kind `"row"` addresses to replace exactly this row's choices in place.
   */
  id: string;

  /**
   * The tag marking this row as the choices form.
   */
  kind: "choices";

  /**
   * The human-readable row label. The label travels with the snapshot so the panel need not know the row-to-label mapping.
   */
  label: string;
}

/**
 * One rendered choices row: a {@link StatusChoicesRowTemplate} plus the list it currently shows. Snapshots carry full rows; a subsequent `"row"` event carries this
 * row's id and a whole replacement list.
 *
 * @category WebUI Status
 */
export interface StatusChoicesRow extends StatusChoicesRowTemplate {

  /**
   * The row's current choices, in the order the panel renders them. An empty list renders as the placeholder dash, exactly as an empty text value does.
   */
  choices: StatusChoice[];
}

/**
 * A text row's static vocabulary: its identity, its optional tag, its display label, its optional momentary-value latch, and its width reservation. The tag is
 * optional on this form alone, which makes the text row what an untagged composition means.
 *
 * @category WebUI Status
 */
export interface StatusTextRowTemplate {

  /**
   * The stable row identity a live {@link StatusEvent} of kind `"row"` addresses to update exactly this row's value in place.
   */
  id: string;

  /**
   * The optional tag marking this row as the text form. A row that states no kind is a text row.
   */
  kind?: "text";

  /**
   * The human-readable row label. The label travels with the snapshot so the panel need not know the row-to-label mapping.
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
 * One rendered text row: a {@link StatusTextRowTemplate} plus its current display value. Snapshots carry full rows; subsequent `"row"` events carry only the id and
 * the new value.
 *
 * @category WebUI Status
 */
export interface StatusTextRow extends StatusTextRowTemplate {

  /**
   * The row's current display value. An empty or blank string renders as the placeholder dash.
   */
  value: string;
}

/**
 * A status row's static vocabulary in either form, tagged on `kind`. The panel's placeholder configuration speaks templates; the wire speaks full {@link StatusRow}s
 * that add the live value or the live list.
 *
 * The vocabulary grows additively in this library as new row forms are needed, and the panel's contract for a form it does not recognize is honest degradation: it
 * renders that row's label over the placeholder dash and leaves every neighboring row working, so a plugin composing a newer form against an older panel loses that
 * one row's content rather than the panel.
 *
 * @category WebUI Status
 */
export type StatusRowTemplate = StatusChoicesRowTemplate | StatusTextRowTemplate;

/**
 * One rendered status row in either form: a text row carrying its display value, or a choices row carrying its list.
 *
 * @category WebUI Status
 */
export type StatusRow = StatusChoicesRow | StatusTextRow;

/**
 * The payload a `"row"` event carries: the addressed row's id plus the one thing that changed, stated in that row's own vocabulary - a replacement `value` for a text
 * row, or a whole replacement `choices` list for a choices row. Either way the panel writes the addressed row in place rather than rebuilding the panel around it.
 *
 * The two arms exclude each other through the `never`-typed guards, so a literal carrying both `choices` and `value` fails to compile. That exclusivity is
 * authoring-side protection for a TypeScript composer and nothing more: the panel's runtime authority for what an update MEANS is the kind of the template the
 * addressed row was declared with, never the shape of the payload, so a text row addressed with a choices-shaped update degrades to the placeholder dash rather than
 * changing form.
 *
 * @category WebUI Status
 */
export type StatusRowUpdate =
  (Pick<StatusChoicesRow, "choices" | "id"> & { value?: never }) |
  (Pick<StatusTextRow, "id" | "value"> & { choices?: never });

/**
 * The classified reasons a status feed can fail to render, each mapping to distinct panel copy. Deliberately credential-neutral: `auth-invalid` / `auth-missing`
 * serve a PSK, a password, or a token equally. `misconfigured` (needing attention in its own app), `not-ready` (still starting), `throttled` (limiting its
 * requests), and `unsupported` (not one this plugin works with) each name what a device that answered is doing, as distinct from a device that did not answer or
 * refused a credential. The vocabulary grows additively in `homebridge-plugin-utils` when an adapter needs a new classification, never as a per-plugin fork.
 *
 * @category WebUI Status
 */
export type StatusErrorReason = "auth-invalid" | "auth-missing" | "misconfigured" | "not-found" | "not-ready" | "throttled" | "timeout" | "unreachable" | "unsupported";

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
 * Two members carry row content. A `snapshot` carries the authoritative `rows` set as full {@link StatusRow}s in either form, and a row absent from it disappears from
 * the panel. A `row` event carries a {@link StatusRowUpdate}, addressing one row by id and replacing only what that row's own form holds - a text value or a whole
 * choices list.
 *
 * The union grows additively in this library, and `hello`'s field set is itself additive.
 *
 * @category WebUI Status
 */
export type StatusEvent =
  { generation: number; kind: "hello" } |
  { kind: "connecting"; serialNumber: string; session: number } |
  { encrypted: boolean; kind: "snapshot"; online: true; rows: StatusRow[]; serialNumber: string; session: number } |
  { kind: "row"; row: StatusRowUpdate; serialNumber: string; session: number } |
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
