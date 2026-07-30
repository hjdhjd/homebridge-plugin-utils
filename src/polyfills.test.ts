/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * polyfills.test.ts: Unit tests for the explicit-resource-management floor bridge - the parametric installer landing exactly the three constructors on a target that
 * has none, the installed references being usable (a stack constructed through one disposes correctly), and a target that already carries all three, or some of them,
 * keeping every reference it had.
 */
import { describe, test } from "node:test";
import { AsyncDisposableStack } from "./async-disposable-stack.ts";
import { DisposableStack } from "./disposable-stack.ts";
import type { ErmInstallTarget } from "./polyfills.ts";
import { SuppressedError } from "./suppressed-error.ts";
import assert from "node:assert/strict";
import { installErmPolyfills } from "./polyfills.ts";

/* The absent-global arm is exercised by handing the installer a plain object rather than by deleting entries from the live `globalThis`. Doctoring the real globals
 * would leak across every other suite in the process and would say nothing the parametric target does not: the installer's behavior is a function of what its target
 * carries, and a bare object carries nothing, exactly like the runtime floor this module bridges.
 *
 * Importing this module also runs its own top-level install against the real `globalThis`, which is how a consumer's single side-effect import works. On a runtime that
 * already ships the constructors - which every environment this suite runs on does - that install is a no-op by design, so there is nothing observable to assert about
 * it here; the tests below pin the installer's behavior on both arms directly instead.
 */

// Stand-ins that are NOT this package's constructors, so "left untouched" is proven by reference identity rather than by two references that happen to be the same
// object.
class ForeignAsyncDisposableStack extends AsyncDisposableStack {}

class ForeignDisposableStack extends DisposableStack {}

// The SuppressedError stand-in carries the same single type assertion the real constructor's definition site does, and for the same reason: TypeScript attaches a
// construct signature only to a class, and a class cannot satisfy this contract's bare call signature.
function foreignSuppressedError(error: unknown, suppressed: unknown, message?: string): SuppressedError {

  return new SuppressedError(error, suppressed, message);
}

const ForeignSuppressedError = foreignSuppressedError as SuppressedErrorConstructor;

describe("installErmPolyfills - a target missing the globals", () => {

  test("lands exactly the three explicit-resource-management constructors", () => {

    const target: ErmInstallTarget = {};

    installErmPolyfills(target);

    assert.deepEqual(Object.keys(target).sort(), [ "AsyncDisposableStack", "DisposableStack", "SuppressedError" ], "exactly the three named constructors are installed");
    assert.equal(target.AsyncDisposableStack, AsyncDisposableStack, "the async stack shim is installed by reference");
    assert.equal(target.DisposableStack, DisposableStack, "the sync stack shim is installed by reference");
    assert.equal(target.SuppressedError, SuppressedError, "the shared SuppressedError constructor is installed by reference");
  });

  test("the installed references are usable constructors", async () => {

    const target: ErmInstallTarget = {};

    installErmPolyfills(target);

    // Construct and dispose through the installed references, which is exactly what a construction site does after a consumer's entry-point import. Installing a
    // reference that cannot be constructed through would satisfy an identity check and still leave the consumer broken.
    const InstalledAsyncStack = target.AsyncDisposableStack;
    const InstalledSyncStack = target.DisposableStack;
    const InstalledSuppressedError = target.SuppressedError;

    assert.ok(InstalledAsyncStack, "the async stack constructor is present");
    assert.ok(InstalledSyncStack, "the sync stack constructor is present");
    assert.ok(InstalledSuppressedError, "the SuppressedError constructor is present");

    const order: string[] = [];
    const asyncStack = new InstalledAsyncStack();
    const syncStack = new InstalledSyncStack();

    asyncStack.defer(() => void order.push("async-a"));
    asyncStack.defer(() => void order.push("async-b"));
    syncStack.defer(() => order.push("sync-a"));
    syncStack.defer(() => order.push("sync-b"));

    await asyncStack.disposeAsync();
    syncStack.dispose();

    assert.deepEqual(order, [ "async-b", "async-a", "sync-b", "sync-a" ], "both installed stacks dispose last-in-first-out");

    const chained = new InstalledSuppressedError("newest", "superseded");

    assert.equal(chained.name, "SuppressedError");
    assert.equal(chained.error, "newest");
    assert.equal(chained.suppressed, "superseded");
  });
});

describe("installErmPolyfills - a target that already has the globals", () => {

  test("leaves every present constructor untouched", () => {

    const target: ErmInstallTarget = {

      AsyncDisposableStack: ForeignAsyncDisposableStack,
      DisposableStack: ForeignDisposableStack,
      SuppressedError: ForeignSuppressedError
    };

    installErmPolyfills(target);

    // Reference identity is the whole assertion: `??=` must not overwrite what a runtime - or an earlier installer in a shared process - already supplied.
    assert.equal(target.AsyncDisposableStack, ForeignAsyncDisposableStack);
    assert.equal(target.DisposableStack, ForeignDisposableStack);
    assert.equal(target.SuppressedError, ForeignSuppressedError);
  });

  test("fills only what is missing when a target is partly populated", () => {

    const target: ErmInstallTarget = { DisposableStack: ForeignDisposableStack };

    installErmPolyfills(target);

    // Each constructor is decided on its own, so a target holding one of the three keeps it while the other two are supplied. An all-or-nothing install would either
    // overwrite the present one or skip the absent two.
    assert.equal(target.DisposableStack, ForeignDisposableStack, "the present constructor is kept");
    assert.equal(target.AsyncDisposableStack, AsyncDisposableStack, "the absent async stack is supplied");
    assert.equal(target.SuppressedError, SuppressedError, "the absent SuppressedError is supplied");
  });

  test("a repeat install changes nothing", () => {

    const target: ErmInstallTarget = {};

    installErmPolyfills(target);
    installErmPolyfills(target);

    assert.equal(target.AsyncDisposableStack, AsyncDisposableStack);
    assert.equal(target.DisposableStack, DisposableStack);
    assert.equal(target.SuppressedError, SuppressedError);
  });
});
