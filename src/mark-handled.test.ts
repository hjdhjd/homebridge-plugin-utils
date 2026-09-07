/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mark-handled.test.ts: Unit tests for markHandled - the identity it hands back for mark-and-assign, and the unhandled-rejection tracking it suppresses without
 * consuming the rejection a caller may still be waiting to see.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { markHandled } from "./mark-handled.ts";

describe("markHandled", () => {

  test("returns the original promise unchanged for chained assignment", () => {

    const resolvers: PromiseWithResolvers<number> = Promise.withResolvers();

    assert.equal(markHandled(resolvers.promise), resolvers.promise);
  });

  test("suppresses unhandled-rejection tracking without consuming the rejection", async () => {

    // The original promise still rejects through any observer's own chain - `markHandled` opts out of Node's unhandled-rejection warning but does not swallow the
    // error. A caller attaching a `.catch` after the call site still sees the rejection.
    const resolvers: PromiseWithResolvers<number> = Promise.withResolvers();
    const reason = new Error("boom");
    const handled = markHandled(resolvers.promise);

    resolvers.reject(reason);

    await assert.rejects(handled, (error: unknown) => error === reason);
  });

  test("resolves pass through unchanged", async () => {

    const resolvers: PromiseWithResolvers<string> = Promise.withResolvers();
    const handled = markHandled(resolvers.promise);

    resolvers.resolve("ok");

    assert.equal(await handled, "ok");
  });
});
