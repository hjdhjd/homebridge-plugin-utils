/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * accessory-persistence.test.ts: Unit tests for AccessoryPersistence - marks gathered into one save per window, the one-second window that stays where the first mark
 * opened it, the context merge that marks on every call however the values compare, unregistering that drops a pending save before Homebridge is called, the bridge
 * check that keeps every accessory off the bridge out of Homebridge's save and unregister calls, the explicit flush, the shutdown save and the immediate save after
 * it, the compile-time check a typed context gives the changes a call names, and the compile-time claim that Homebridge's API satisfies the part of it the helper
 * takes.
 *
 * Every row runs on the testing entry point's Homebridge double: its accessories are Homebridge's own PlatformAccessory over the hap-nodejs copy Homebridge loads,
 * an accessory on the bridge got there the way Homebridge puts one there, by a registration or a restore, and the API double records the calls the helper makes.
 */
import { ACCESSORY_SAVE_WINDOW_MS, AccessoryPersistence } from "./accessory-persistence.ts";
import type { API, PlatformAccessory, UnknownContext } from "homebridge";
import type { TestHomebridgeApi, TestHomebridgeApiCall, TestPlatformAccessory } from "./testing/index.ts";
import { describe, test } from "node:test";
import { loadHomebridge, watchServerWarnings } from "./testing/index.ts";
import { APIEvent } from "./homebridge-enums.ts";
import type { AccessoryPersistenceApi } from "./accessory-persistence.ts";
import { TestClock } from "./clock-double.ts";
import assert from "node:assert/strict";

// The runtime every row runs on, resolved from this repository's own tree.
const runtime = await loadHomebridge(import.meta.url);

// The plugin identifier and platform name the helper hands Homebridge's unregister call.
const PLUGIN = "homebridge-test";
const PLATFORM = "TestPlatform";

// An accessory made through the API double, carrying the given context, and registered with Homebridge so it is on the bridge unless a row says otherwise. Each
// accessory takes a UUID of its own from its place among the accessories the API made, because Homebridge skips a registration whose UUID it already holds.
function createAccessory<C extends UnknownContext>(api: TestHomebridgeApi, context: C, { bridged = true }: { bridged?: boolean } = {}): TestPlatformAccessory<C> {

  const index = api.accessories.length.toString();
  const accessory = new api.platformAccessory<C>("Accessory " + index, api.hap.uuid.generate("homebridge-plugin-utils.accessory-persistence-test." + index));

  accessory.context = context;

  if(bridged) {

    api.registerPlatformAccessories(PLUGIN, PLATFORM, [accessory]);
  }

  return accessory;
}

// The accessories each of Homebridge's update calls carried, in arrival order: the saves the helper made.
function saves(api: TestHomebridgeApi): (readonly PlatformAccessory[])[] {

  return api.calls.filter((call) => call.kind === "update").map((call) => call.accessories);
}

// Homebridge's unregister calls, in the order they arrived.
function unregistrations(api: TestHomebridgeApi): TestHomebridgeApiCall[] {

  return api.calls.filter((call) => call.kind === "unregister");
}

// The builder every row's API double comes from, each double checked for untaken warnings after every row once the row's own cleanups have run.
const buildApi = watchServerWarnings(runtime);

// Build the helper over a fresh API double and test clock, which every row drives. The double satisfies the part of Homebridge's API the helper declares, so it
// is handed over as it is.
function setup(): { api: TestHomebridgeApi; clock: TestClock; persistence: AccessoryPersistence } {

  const api = buildApi();
  const clock = new TestClock();
  const persistence = new AccessoryPersistence({ api, clock, platformName: PLATFORM, pluginIdentifier: PLUGIN });

  return { api, clock, persistence };
}

describe("AccessoryPersistence", () => {

  test("marks within one window are saved together in a single update, each accessory once, a second after the first mark", () => {

    const { api, clock, persistence } = setup();
    const first = createAccessory(api, { name: "first" });
    const second = createAccessory(api, { name: "second" });

    persistence.persist(first);
    persistence.persist(second);
    persistence.persist(first);

    const deadline = clock.nextDeadline ?? assert.fail("the first mark must open a save window");

    assert.equal(ACCESSORY_SAVE_WINDOW_MS, 1000, "the exported save window must be one second");
    assert.equal(deadline, ACCESSORY_SAVE_WINDOW_MS, "the window must close one second after the first mark");

    clock.advance(deadline - 1);

    assert.deepEqual(saves(api), [], "nothing may be saved before the window closes");

    clock.advance(1);

    assert.deepEqual(saves(api), [[ first, second ]], "the window must save every marked accessory in one update, each once");
  });

  test("the window stays where the first mark opened it, so a later mark cannot hold the save off", () => {

    const { api, clock, persistence } = setup();
    const first = createAccessory(api, { name: "first" });
    const second = createAccessory(api, { name: "second" });

    persistence.persist(first);

    const deadline = clock.nextDeadline ?? assert.fail("the first mark must open a save window");

    clock.advance(deadline - 1);
    persistence.persist(second);

    assert.equal(clock.nextDeadline, deadline, "a later mark must not move the window");
    assert.equal(clock.pending, 1, "a later mark must not open a second window");

    clock.advance(1);

    assert.deepEqual(saves(api), [[ first, second ]], "the later mark must go out with the window the first one opened");
  });

  test("a mark after a save opens a fresh window", () => {

    const { api, clock, persistence } = setup();
    const first = createAccessory(api, { name: "first" });
    const second = createAccessory(api, { name: "second" });

    persistence.persist(first);
    clock.advanceToNext();
    persistence.persist(second);

    assert.equal(clock.pending, 1, "a mark after a save must open a window of its own");

    clock.advanceToNext();

    assert.deepEqual(saves(api), [ [first], [second] ], "each window must save only what was marked within it");
  });

  test("changes are merged into the context before the accessory is saved, leaving every other field as it was", () => {

    const { api, clock, persistence } = setup();
    const accessory = createAccessory(api, { doorbellMuted: false, mac: "AA:BB:CC:DD:EE:FF" });

    persistence.persist(accessory, { doorbellMuted: true });

    assert.deepEqual(accessory.context, { doorbellMuted: true, mac: "AA:BB:CC:DD:EE:FF" }, "the change must land in the context at once");

    clock.advanceToNext();

    assert.deepEqual(saves(api), [[accessory]], "the changed accessory must be saved with the window");
  });

  test("every call with changes marks the accessory, an object edited in place and handed back included", () => {

    const { api, clock, persistence } = setup();
    const schedule = { start: 1 };
    const accessory = createAccessory(api, { detectMotion: true, schedule });

    persistence.persist(accessory, { detectMotion: true });
    clock.advanceToNext();

    schedule.start = 2;
    persistence.persist(accessory, { schedule });
    clock.advanceToNext();

    assert.deepEqual(saves(api), [ [accessory], [accessory] ], "a call must mark the accessory however its values compare with what the context held");
  });

  test("an accessory off the bridge is left out of the save, and a window holding nothing else makes no call", () => {

    const { api, clock, persistence } = setup();
    const bridged = createAccessory(api, { name: "bridged" });
    const external = createAccessory(api, { name: "external" }, { bridged: false });

    persistence.persist(bridged);
    persistence.persist(external);
    clock.advanceToNext();

    assert.deepEqual(saves(api), [[bridged]], "only the accessory on the bridge may reach Homebridge's save");

    persistence.persist(external);
    clock.advanceToNext();

    assert.equal(saves(api).length, 1, "a window holding only accessories off the bridge must make no call");

    // The accessory joins the bridge afterward, through a registration. Had it been kept waiting, the next save would carry it.
    api.registerPlatformAccessories(PLUGIN, PLATFORM, [external]);
    persistence.persist(bridged);
    clock.advanceToNext();

    assert.deepEqual(saves(api), [ [bridged], [bridged] ], "an accessory off the bridge must leave the set rather than wait for a later save");
  });

  test("the bridge is read when the window saves, so an accessory marked before it joins the bridge is saved", () => {

    const { api, clock, persistence } = setup();
    const restored = createAccessory(api, { name: "restored" }, { bridged: false });

    // Homebridge places a restored accessory on its bridge once the plugin's configureAccessory returns, after a mark made inside that call.
    api.restorePlatformAccessories({ accessories: [restored], platform: { configureAccessory: (accessory): void => persistence.persist(accessory) },
      platformName: PLATFORM, pluginIdentifier: PLUGIN });
    clock.advanceToNext();

    assert.deepEqual(saves(api), [[restored]], "an accessory on the bridge when the window closes must be saved, wherever it was when marked");
  });

  test("unregistering drops a pending save first and hands Homebridge the plugin's identifier and platform name", () => {

    const { api, clock, persistence } = setup();
    const first = createAccessory(api, { name: "first" });
    const second = createAccessory(api, { name: "second" });

    persistence.persist(first);
    persistence.persist(second);
    persistence.unregister([first]);

    assert.deepEqual(unregistrations(api), [{ accessories: [first], kind: "unregister", platformName: "TestPlatform", pluginIdentifier: "homebridge-test" }],
      "the removal must reach Homebridge under the plugin's identifier and platform name");

    clock.advanceToNext();

    assert.deepEqual(saves(api), [[second]], "an unregistered accessory must never reach a save, or Homebridge would cache it again");
  });

  test("a pending save is dropped before Homebridge is called, so a removal Homebridge refuses still never saves the accessory", (t) => {

    const { api, clock, persistence } = setup();
    const accessory = createAccessory(api, { name: "only" });
    const refusal = new Error("Cannot find the bridged Accessory to remove.");

    persistence.persist(accessory);
    t.mock.method(api, "unregisterPlatformAccessories", (): never => {

      throw refusal;
    });

    assert.throws(() => persistence.unregister([accessory]), refusal, "Homebridge's refusal must reach the plugin");

    clock.advanceToNext();

    assert.deepEqual(saves(api), [], "the pending save must already be gone when Homebridge refuses the removal");
  });

  test("unregistering hands Homebridge only the accessories on its bridge, and makes no call when none are", () => {

    const { api, persistence } = setup();
    const bridged = createAccessory(api, { name: "bridged" });
    const external = createAccessory(api, { name: "external" }, { bridged: false });

    persistence.unregister([ external, bridged ]);

    assert.deepEqual(unregistrations(api), [{ accessories: [bridged], kind: "unregister", platformName: "TestPlatform", pluginIdentifier: "homebridge-test" }],
      "only the accessory on the bridge may reach Homebridge's unregister");

    persistence.unregister([external]);

    assert.equal(unregistrations(api).length, 1, "a removal with nothing on the bridge must make no call");
  });

  test("a mark that arrives after an accessory's removal is left out of the save", () => {

    const { api, clock, persistence } = setup();
    const accessory = createAccessory(api, { name: "only" });

    persistence.unregister([accessory]);
    persistence.persist(accessory);
    clock.advanceToNext();

    assert.deepEqual(saves(api), [], "a removed accessory must never return to the cache through a late mark");
  });

  test("a window whose every accessory was unregistered closes without a save", () => {

    const { api, clock, persistence } = setup();
    const accessory = createAccessory(api, { name: "only" });

    persistence.persist(accessory);
    persistence.unregister([accessory]);
    clock.advanceToNext();

    assert.deepEqual(saves(api), [], "a window with nothing left waiting must make no call");
  });

  test("a flush saves at once and closes the window, and a flush with nothing waiting makes no call", () => {

    const { api, clock, persistence } = setup();
    const accessory = createAccessory(api, { name: "only" });

    persistence.persist(accessory);
    persistence.flush();

    assert.deepEqual(saves(api), [[accessory]], "a flush must save what is waiting at once");
    assert.equal(clock.pending, 0, "a flush must close the window it saved");

    persistence.flush();

    assert.equal(saves(api).length, 1, "a flush with nothing waiting must make no call");
  });

  test("Homebridge's shutdown saves whatever is waiting, and a mark after it is saved at once", () => {

    const { api, clock, persistence } = setup();
    const first = createAccessory(api, { name: "first" });
    const second = createAccessory(api, { name: "second" });

    persistence.persist(first);
    api.emit(APIEvent.SHUTDOWN);

    assert.deepEqual(saves(api), [[first]], "shutdown must save what the window held");
    assert.equal(clock.pending, 0, "shutdown must close the window it saved");

    persistence.persist(second);

    assert.deepEqual(saves(api), [ [first], [second] ], "a mark after shutdown must be saved at once");
    assert.equal(clock.pending, 0, "a mark after shutdown must open no window");
  });

  test("Homebridge's shutdown with nothing waiting makes no call", () => {

    const { api } = setup();

    api.emit(APIEvent.SHUTDOWN);

    assert.deepEqual(saves(api), [], "a shutdown with nothing waiting must make no call");
  });
});

/* Compile-time shape exercises for the changes a typed context accepts. These never run - the function is never called, and its leading underscore marks it, with its
 * bindings, as a compile-time exercise the typecheck reads - so they add nothing to the runtime totals. The negative cases use `@ts-expect-error`, which fails the
 * build if the error each expects ever stops occurring. The context type is inferred from the accessory alone, so a change can never widen it.
 */
const _typedContextExercises = (api: TestHomebridgeApi, persistence: AccessoryPersistence): void => {

  // Homebridge's class is generic over the context, and the double's construct signature keeps that, so the accessory's context is typed with no cast.
  const uuid = api.hap.uuid.generate("homebridge-plugin-utils.accessory-persistence-test.doorbell");
  const accessory = new api.platformAccessory<{ doorbellMuted: boolean }>("Doorbell", uuid);

  accessory.context = { doorbellMuted: false };
  persistence.persist(accessory, { doorbellMuted: true });

  // @ts-expect-error - a typed context refuses a field it does not declare.
  persistence.persist(accessory, { doorbelMuted: true });

  // @ts-expect-error - a typed context refuses a value of the wrong type for a field it declares.
  persistence.persist(accessory, { doorbellMuted: "yes" });

  // An accessory with a typed context is unregistered as readily as one without.
  persistence.unregister([accessory]);
};

/* A compile-time acceptance claim for the API the helper takes, which never runs. Homebridge's API cannot be built in a suite, so the claim is a function from it
 * to the helper's interface that returns its argument, and it compiles only while the API Homebridge hands a plugin satisfies that interface.
 */
const _homebridgeApiAccepted: (api: API) => AccessoryPersistenceApi = (api) => api;
