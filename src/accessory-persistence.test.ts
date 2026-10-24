/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * accessory-persistence.test.ts: Unit tests for AccessoryPersistence - marks gathered into one save per window, the one-second window that stays where the first mark
 * opened it, the context merge that marks on every call however the values compare, unregistering that drops a pending save before Homebridge is called, the bridge
 * check that keeps every accessory off the bridge out of Homebridge's save and unregister calls, the explicit flush, the shutdown save and the immediate save after
 * it, and the compile-time check a typed context gives the changes a call names.
 */
import type { API, PlatformAccessory, UnknownContext } from "homebridge";
import { describe, test } from "node:test";
import { APIEvent } from "./homebridge-enums.ts";
import { AccessoryPersistence } from "./accessory-persistence.ts";
import { EventEmitter } from "node:events";
import { TestClock } from "./clock-double.ts";
import assert from "node:assert/strict";

/* A stand-in for the Homebridge API carrying the members the helper reaches: the update and unregister calls, recorded in the order they arrive, and the shutdown
 * event, which a row emits the way Homebridge's teardown does. Extending EventEmitter supplies `on` and `emit` exactly as Homebridge's own API class inherits them.
 * An unregister takes each accessory off the bridge, as hap-nodejs does, and throws `unregisterError` first when a row sets one, standing in for a removal Homebridge
 * refuses.
 */
class FakeApi extends EventEmitter {

  public readonly saves: PlatformAccessory[][] = [];

  public unregisterError: Error | undefined;

  public readonly unregistrations: { accessories: PlatformAccessory[]; platformName: string; pluginIdentifier: string }[] = [];

  public updatePlatformAccessories(accessories: PlatformAccessory[]): void {

    this.saves.push(accessories);
  }

  public unregisterPlatformAccessories(pluginIdentifier: string, platformName: string, accessories: PlatformAccessory[]): void {

    if(this.unregisterError) {

      throw this.unregisterError;
    }

    for(const accessory of accessories) {

      accessory._associatedHAPAccessory.bridged = false;
    }

    this.unregistrations.push({ accessories, platformName, pluginIdentifier });
  }
}

// The helper reads and writes an accessory's context, reads whether the bridge holds it, and otherwise holds it only by identity, so a bare object carrying a context
// and that one field of its HAP accessory stands in for one exactly. An accessory is on the bridge unless a row says otherwise.
function makeAccessory<C extends UnknownContext>(context: C, { bridged = true }: { bridged?: boolean } = {}): PlatformAccessory<C> {

  return { _associatedHAPAccessory: { bridged }, context } as unknown as PlatformAccessory<C>;
}

// Build the helper over a fresh fake API and test clock, which every row drives.
function setup(): { api: FakeApi; clock: TestClock; persistence: AccessoryPersistence } {

  const api = new FakeApi();
  const clock = new TestClock();
  const persistence = new AccessoryPersistence({ api: api as unknown as API, clock, platformName: "TestPlatform", pluginIdentifier: "homebridge-test" });

  return { api, clock, persistence };
}

describe("AccessoryPersistence", () => {

  test("marks within one window are saved together in a single update, each accessory once, a second after the first mark", () => {

    const { api, clock, persistence } = setup();
    const first = makeAccessory({ name: "first" });
    const second = makeAccessory({ name: "second" });

    persistence.persist(first);
    persistence.persist(second);
    persistence.persist(first);

    const deadline = clock.nextDeadline ?? assert.fail("the first mark must open a save window");

    assert.equal(deadline, 1000, "the window must close one second after the first mark");

    clock.advance(deadline - 1);

    assert.deepEqual(api.saves, [], "nothing may be saved before the window closes");

    clock.advance(1);

    assert.deepEqual(api.saves, [[ first, second ]], "the window must save every marked accessory in one update, each once");
  });

  test("the window stays where the first mark opened it, so a later mark cannot hold the save off", () => {

    const { api, clock, persistence } = setup();
    const first = makeAccessory({ name: "first" });
    const second = makeAccessory({ name: "second" });

    persistence.persist(first);

    const deadline = clock.nextDeadline ?? assert.fail("the first mark must open a save window");

    clock.advance(deadline - 1);
    persistence.persist(second);

    assert.equal(clock.nextDeadline, deadline, "a later mark must not move the window");
    assert.equal(clock.pending, 1, "a later mark must not open a second window");

    clock.advance(1);

    assert.deepEqual(api.saves, [[ first, second ]], "the later mark must go out with the window the first one opened");
  });

  test("a mark after a save opens a fresh window", () => {

    const { api, clock, persistence } = setup();
    const first = makeAccessory({ name: "first" });
    const second = makeAccessory({ name: "second" });

    persistence.persist(first);
    clock.advanceToNext();
    persistence.persist(second);

    assert.equal(clock.pending, 1, "a mark after a save must open a window of its own");

    clock.advanceToNext();

    assert.deepEqual(api.saves, [ [first], [second] ], "each window must save only what was marked within it");
  });

  test("changes are merged into the context before the accessory is saved, leaving every other field as it was", () => {

    const { api, clock, persistence } = setup();
    const accessory = makeAccessory({ doorbellMuted: false, mac: "AA:BB:CC:DD:EE:FF" });

    persistence.persist(accessory, { doorbellMuted: true });

    assert.deepEqual(accessory.context, { doorbellMuted: true, mac: "AA:BB:CC:DD:EE:FF" }, "the change must land in the context at once");

    clock.advanceToNext();

    assert.deepEqual(api.saves, [[accessory]], "the changed accessory must be saved with the window");
  });

  test("every call with changes marks the accessory, an object edited in place and handed back included", () => {

    const { api, clock, persistence } = setup();
    const schedule = { start: 1 };
    const accessory = makeAccessory({ detectMotion: true, schedule });

    persistence.persist(accessory, { detectMotion: true });
    clock.advanceToNext();

    schedule.start = 2;
    persistence.persist(accessory, { schedule });
    clock.advanceToNext();

    assert.deepEqual(api.saves, [ [accessory], [accessory] ], "a call must mark the accessory however its values compare with what the context held");
  });

  test("an accessory off the bridge is left out of the save, and a window holding nothing else makes no call", () => {

    const { api, clock, persistence } = setup();
    const bridged = makeAccessory({ name: "bridged" });
    const external = makeAccessory({ name: "external" }, { bridged: false });

    persistence.persist(bridged);
    persistence.persist(external);
    clock.advanceToNext();

    assert.deepEqual(api.saves, [[bridged]], "only the accessory on the bridge may reach Homebridge's save");

    persistence.persist(external);
    clock.advanceToNext();

    assert.equal(api.saves.length, 1, "a window holding only accessories off the bridge must make no call");

    // The accessory joins the bridge afterward, as a registration would place it there. Had it been kept waiting, the next save would carry it.
    external._associatedHAPAccessory.bridged = true;
    persistence.persist(bridged);
    clock.advanceToNext();

    assert.deepEqual(api.saves, [ [bridged], [bridged] ], "an accessory off the bridge must leave the set rather than wait for a later save");
  });

  test("the bridge is read when the window saves, so an accessory marked before it joins the bridge is saved", () => {

    const { api, clock, persistence } = setup();
    const restored = makeAccessory({ name: "restored" }, { bridged: false });

    persistence.persist(restored);

    // Homebridge places a restored accessory on its bridge once the plugin's configureAccessory returns, after a mark made inside that call.
    restored._associatedHAPAccessory.bridged = true;
    clock.advanceToNext();

    assert.deepEqual(api.saves, [[restored]], "an accessory on the bridge when the window closes must be saved, wherever it was when marked");
  });

  test("unregistering drops a pending save first and hands Homebridge the plugin's identifier and platform name", () => {

    const { api, clock, persistence } = setup();
    const first = makeAccessory({ name: "first" });
    const second = makeAccessory({ name: "second" });

    persistence.persist(first);
    persistence.persist(second);
    persistence.unregister([first]);

    assert.deepEqual(api.unregistrations, [{ accessories: [first], platformName: "TestPlatform", pluginIdentifier: "homebridge-test" }],
      "the removal must reach Homebridge under the plugin's identifier and platform name");

    clock.advanceToNext();

    assert.deepEqual(api.saves, [[second]], "an unregistered accessory must never reach a save, or Homebridge would cache it again");
  });

  test("a pending save is dropped before Homebridge is called, so a removal Homebridge refuses still never saves the accessory", () => {

    const { api, clock, persistence } = setup();
    const accessory = makeAccessory({ name: "only" });

    persistence.persist(accessory);
    api.unregisterError = new Error("Cannot find the bridged Accessory to remove.");

    assert.throws(() => persistence.unregister([accessory]), api.unregisterError, "Homebridge's refusal must reach the plugin");

    clock.advanceToNext();

    assert.deepEqual(api.saves, [], "the pending save must already be gone when Homebridge refuses the removal");
  });

  test("unregistering hands Homebridge only the accessories on its bridge, and makes no call when none are", () => {

    const { api, persistence } = setup();
    const bridged = makeAccessory({ name: "bridged" });
    const external = makeAccessory({ name: "external" }, { bridged: false });

    persistence.unregister([ external, bridged ]);

    assert.deepEqual(api.unregistrations, [{ accessories: [bridged], platformName: "TestPlatform", pluginIdentifier: "homebridge-test" }],
      "only the accessory on the bridge may reach Homebridge's unregister");

    persistence.unregister([external]);

    assert.equal(api.unregistrations.length, 1, "a removal with nothing on the bridge must make no call");
  });

  test("a mark that arrives after an accessory's removal is left out of the save", () => {

    const { api, clock, persistence } = setup();
    const accessory = makeAccessory({ name: "only" });

    persistence.unregister([accessory]);
    persistence.persist(accessory);
    clock.advanceToNext();

    assert.deepEqual(api.saves, [], "a removed accessory must never return to the cache through a late mark");
  });

  test("a window whose every accessory was unregistered closes without a save", () => {

    const { api, clock, persistence } = setup();
    const accessory = makeAccessory({ name: "only" });

    persistence.persist(accessory);
    persistence.unregister([accessory]);
    clock.advanceToNext();

    assert.deepEqual(api.saves, [], "a window with nothing left waiting must make no call");
  });

  test("a flush saves at once and closes the window, and a flush with nothing waiting makes no call", () => {

    const { api, clock, persistence } = setup();
    const accessory = makeAccessory({ name: "only" });

    persistence.persist(accessory);
    persistence.flush();

    assert.deepEqual(api.saves, [[accessory]], "a flush must save what is waiting at once");
    assert.equal(clock.pending, 0, "a flush must close the window it saved");

    persistence.flush();

    assert.equal(api.saves.length, 1, "a flush with nothing waiting must make no call");
  });

  test("Homebridge's shutdown saves whatever is waiting, and a mark after it is saved at once", () => {

    const { api, clock, persistence } = setup();
    const first = makeAccessory({ name: "first" });
    const second = makeAccessory({ name: "second" });

    persistence.persist(first);
    api.emit(APIEvent.SHUTDOWN);

    assert.deepEqual(api.saves, [[first]], "shutdown must save what the window held");
    assert.equal(clock.pending, 0, "shutdown must close the window it saved");

    persistence.persist(second);

    assert.deepEqual(api.saves, [ [first], [second] ], "a mark after shutdown must be saved at once");
    assert.equal(clock.pending, 0, "a mark after shutdown must open no window");
  });

  test("Homebridge's shutdown with nothing waiting makes no call", () => {

    const { api } = setup();

    api.emit(APIEvent.SHUTDOWN);

    assert.deepEqual(api.saves, [], "a shutdown with nothing waiting must make no call");
  });
});

/* Compile-time shape exercises for the changes a typed context accepts. These never run - the function is never called, and its leading underscore marks it, with its
 * bindings, as a compile-time exercise the typecheck reads - so they add nothing to the runtime totals. The negative cases use `@ts-expect-error`, which fails the
 * build if the error each expects ever stops occurring. The context type is inferred from the accessory alone, so a change can never widen it.
 */
const _typedContextExercises = (persistence: AccessoryPersistence): void => {

  const accessory = makeAccessory<{ doorbellMuted: boolean }>({ doorbellMuted: false });

  persistence.persist(accessory, { doorbellMuted: true });

  // @ts-expect-error - a typed context refuses a field it does not declare.
  persistence.persist(accessory, { doorbelMuted: true });

  // @ts-expect-error - a typed context refuses a value of the wrong type for a field it declares.
  persistence.persist(accessory, { doorbellMuted: "yes" });

  // An accessory with a typed context is unregistered as readily as one without.
  persistence.unregister([accessory]);
};
