/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webui-status.test.ts: Contract tests for the live device-status wire protocol - the protocol constants, the untrusted view-request narrowing matrix, and the
 * compile-time shape exercises that pin the event union, the template-versus-row relationship, the non-empty sizer tuple, and the offline-implies-unencrypted split.
 */
import { STATUS_EVENT, STATUS_VIEW_ROUTE, narrowStatusViewRequest } from "./webui-status.ts";
import type { StatusEvent, StatusRow, StatusRowTemplate, StatusViewRequest } from "./webui-status.ts";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

/* Compile-time shape exercises. These never run - the function is voided at module scope rather than called - so they add nothing to the runtime totals; TypeScript
 * still type-checks the body during `npm run typecheck`, so a shape regression in the protocol fails the build here rather than silently at a consuming plugin. The
 * negative cases use `@ts-expect-error`, which fails the build if the error it expects ever stops occurring.
 */
const protocolShapeExercises = (): void => {

  // Every kind of the event union constructs at its declared shape.
  const connecting: StatusEvent = { kind: "connecting", serialNumber: "abc", session: 1 };
  const snapshot: StatusEvent = { encrypted: true, kind: "snapshot", online: true, rows: [], serialNumber: "abc", session: 2 };
  const row: StatusEvent = { kind: "row", row: { id: "door", value: "Open" }, serialNumber: "abc", session: 3 };
  const onlineAvailability: StatusEvent = { encrypted: true, kind: "availability", online: true, serialNumber: "abc", session: 4 };
  const offlineAvailability: StatusEvent = { encrypted: false, kind: "availability", online: false, serialNumber: "abc", session: 5 };
  const errored: StatusEvent = { kind: "error", reason: "auth-invalid", serialNumber: "abc", session: 6 };

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

  void [ connecting, snapshot, row, onlineAvailability, offlineAvailability, errored, template, fullRow, latchRow, viewRequest, emptySizer, encryptedOffline ];
};

void protocolShapeExercises;

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
