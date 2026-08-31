/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webui-status.test.ts: Contract tests for the live device-status wire protocol - the protocol constants, the untrusted view-request narrowing matrix, and the
 * compile-time shape exercises that hold the event union, the template-versus-row relationship, the two row forms and their tag discipline, the exclusivity of the
 * update arms, the non-empty sizer tuple, and the offline-implies-unencrypted split fixed against a shape regression.
 */
import { STATUS_EVENT, STATUS_VIEW_ROUTE, narrowStatusViewRequest } from "./webui-status.ts";
import type { StatusChoice, StatusEvent, StatusRow, StatusRowTemplate, StatusRowUpdate, StatusTextRowTemplate, StatusViewRequest } from "./webui-status.ts";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

/* Compile-time shape exercises. These never run - the function is voided at module scope rather than called - so they add nothing to the runtime totals; TypeScript
 * still type-checks the body during `npm run typecheck`, so a shape regression in the protocol fails the build here rather than silently at a consuming plugin. The
 * negative cases use `@ts-expect-error`, which fails the build if the error it expects ever stops occurring.
 */
const protocolShapeExercises = (): void => {

  // Every kind of the event union constructs at its declared shape.
  const hello: StatusEvent = { generation: 1, kind: "hello" };
  const connecting: StatusEvent = { kind: "connecting", serialNumber: "abc", session: 1 };
  const snapshot: StatusEvent = { encrypted: true, kind: "snapshot", online: true, rows: [], serialNumber: "abc", session: 2 };
  const row: StatusEvent = { kind: "row", row: { id: "door", value: "Open" }, serialNumber: "abc", session: 3 };
  const onlineAvailability: StatusEvent = { encrypted: true, kind: "availability", online: true, serialNumber: "abc", session: 4 };
  const offlineAvailability: StatusEvent = { encrypted: false, kind: "availability", online: false, serialNumber: "abc", session: 5 };
  const errored: StatusEvent = { kind: "error", reason: "auth-invalid", serialNumber: "abc", session: 6 };

  // Each word of the failure vocabulary constructs through the error arm, so a word dropped from the union fails the typecheck here rather than at a consuming plugin.
  const misconfigured: StatusEvent = { kind: "error", reason: "misconfigured", serialNumber: "abc", session: 7 };
  const notReady: StatusEvent = { kind: "error", reason: "not-ready", serialNumber: "abc", session: 8 };
  const throttled: StatusEvent = { kind: "error", reason: "throttled", serialNumber: "abc", session: 9 };
  const unsupported: StatusEvent = { kind: "error", reason: "unsupported", serialNumber: "abc", session: 10 };

  // A template carries the static vocabulary; a row extends it with the live value. A latch row and a non-empty sizer tuple both type cleanly.
  const template: StatusRowTemplate = { id: "door", label: "Door", sizer: "Stopped (100%)" };
  const fullRow: StatusRow = { ...template, value: "Open" };
  const latchRow: StatusRow = { id: "motion", label: "Motion", latch: { seconds: 5, value: "Detected" }, sizer: [ "Detected", "Clear" ], value: "Detected" };

  // The view request carries only the identity field.
  const viewRequest: StatusViewRequest = { serialNumber: "abc" };

  // The sizer tuple forbids an empty reservation by construction: an empty array is assignable to neither a bare string nor a non-empty tuple.
  // @ts-expect-error - an empty sizer tuple is rejected.
  const emptySizer: StatusRowTemplate = { id: "x", label: "X", sizer: [] };

  // An offline availability event cannot be encrypted - no transport exists, so the encrypted-and-offline combination is unrepresentable.
  // @ts-expect-error - encrypted: true paired with online: false is not a member of the union.
  const encryptedOffline: StatusEvent = { encrypted: true, kind: "availability", online: false, serialNumber: "abc", session: 7 };

  void [ hello, connecting, snapshot, row, onlineAvailability, offlineAvailability, errored, misconfigured, notReady, throttled, unsupported, template, fullRow,
    latchRow, viewRequest, emptySizer, encryptedOffline ];
};

void protocolShapeExercises;

/* Row-form shape exercises, on the same never-run, always-type-checked footing as the block above. The row vocabulary is a union tagged on `kind`, so what these
 * assert is the tag discipline itself: both forms construct at their declared shapes, an untagged composition reads as a text row, and the two update arms exclude
 * each other so an update can never claim to be both forms at once. Each case is a `satisfies` rather than an annotation, which checks the literal against the
 * contract without widening it, so a property the union would silently absorb still fails here.
 */
const rowFormShapeExercises = (): void => {

  // The text form constructs with its tag stated and with it left out, as a template and as a full row, and every one of them is a member of the row vocabulary.
  const untaggedTemplate = { id: "door", label: "Door", sizer: "Stopped (100%)" } satisfies StatusTextRowTemplate;
  const taggedTemplate = { id: "door", kind: "text", label: "Door", sizer: "Stopped (100%)" } satisfies StatusRowTemplate;
  const untaggedRow = { id: "door", label: "Door", sizer: "Stopped (100%)", value: "Open" } satisfies StatusRow;
  const taggedRow = { id: "door", kind: "text", label: "Door", sizer: "Stopped (100%)", value: "Open" } satisfies StatusRow;

  // The choices form carries its list and declares no width reservation of its own.
  const choice = { label: "Away", selected: true } satisfies StatusChoice;
  const choicesTemplate = { id: "modes", kind: "choices", label: "Modes" } satisfies StatusRowTemplate;
  const choicesRow = { choices: [ choice, { label: "Home", selected: false } ], id: "modes", kind: "choices", label: "Modes" } satisfies StatusRow;

  // Both update shapes construct, and each composes into a `"row"` member of the event union.
  const textUpdate = { id: "door", value: "Closed" } satisfies StatusRowUpdate;
  const choicesUpdate = { choices: [{ label: "Away", selected: false }], id: "modes" } satisfies StatusRowUpdate;
  const textRowEvent: StatusEvent = { kind: "row", row: textUpdate, serialNumber: "abc", session: 1 };
  const choicesRowEvent: StatusEvent = { kind: "row", row: choicesUpdate, serialNumber: "abc", session: 2 };

  // The never-typed guards are what make the arms exclusive; without them a bare two-arm union would admit a literal carrying both, since neither arm shares a tag.
  // @ts-expect-error - an update carrying both choices and value belongs to neither arm.
  const mixedUpdate = { choices: [{ label: "Away", selected: true }], id: "modes", value: "Away" } satisfies StatusRowUpdate;

  void [ untaggedTemplate, taggedTemplate, untaggedRow, taggedRow, choice, choicesTemplate, choicesRow, textUpdate, choicesUpdate, textRowEvent, choicesRowEvent,
    mixedUpdate ];
};

void rowFormShapeExercises;

describe("webui-status - route constants", () => {

  test("the push-event name and view-route are the frozen literals", () => {

    assert.equal(STATUS_EVENT, "status");
    assert.equal(STATUS_VIEW_ROUTE, "/statusView");
  });
});

describe("narrowStatusViewRequest", () => {

  test("accepts a well-formed body carrying a non-empty string serialNumber", () => {

    assert.deepEqual(narrowStatusViewRequest({ serialNumber: "AA:BB:CC:DD:EE:FF" }), { serialNumber: "AA:BB:CC:DD:EE:FF" });
  });

  test("rejects a non-object body", () => {

    assert.equal(narrowStatusViewRequest("not-an-object"), null);
    assert.equal(narrowStatusViewRequest(42), null);
    assert.equal(narrowStatusViewRequest(true), null);
  });

  test("rejects null", () => {

    assert.equal(narrowStatusViewRequest(null), null);
  });

  test("rejects a body missing serialNumber", () => {

    assert.equal(narrowStatusViewRequest({}), null);
    assert.equal(narrowStatusViewRequest({ other: "value" }), null);
  });

  test("rejects an empty-string serialNumber", () => {

    assert.equal(narrowStatusViewRequest({ serialNumber: "" }), null);
  });

  test("rejects a non-string truthy serialNumber - a number, an object, or an array", () => {

    assert.equal(narrowStatusViewRequest({ serialNumber: 12345 }), null);
    assert.equal(narrowStatusViewRequest({ serialNumber: { nested: "value" } }), null);
    assert.equal(narrowStatusViewRequest({ serialNumber: [ "a", "b" ] }), null);
  });

  test("tolerates extra input fields but narrows to a fresh object carrying only serialNumber", () => {

    const input = { extra: 1, nested: { deep: true }, serialNumber: "abc" };
    const result = narrowStatusViewRequest(input);

    assert.deepEqual(result, { serialNumber: "abc" }, "the narrowed result carries only serialNumber");
    assert.notEqual(result, input, "the narrowed result is a fresh object, never a passthrough of the input");
  });
});
