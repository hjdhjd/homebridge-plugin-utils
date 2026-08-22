/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui/pluginConfigSession.test.mjs: Unit tests for the PluginConfigSession config owner.
 */
"use strict";

import { describe, test } from "node:test";
import { PluginConfigSession } from "./pluginConfigSession.mjs";
import assert from "node:assert/strict";

// Minimal host stub matching the {getPluginConfig, savePluginConfig, updatePluginConfig} surface the session uses. getPluginConfig returns the host's CURRENT `config`
// backing - exposed as a settable field on the returned host so a test can reassign it to a new array between open() and sync() to simulate an external Settings-tab
// edit; in-place mutation of the same array would be vacuous, since session.platform aliases that reference. updatePluginConfig records every payload and can be made
// to reject so the transactional-commit contract is exercisable. savePluginConfig carries no payload, so it records a call count on `saves` instead, incremented
// before any rejection so a test can assert the save reached the host even when it fails. `rejectReads` and `rejectSaves` fail the read and save paths independently
// of the write path and of each other.
const makeHost = ({ config = [], reject = false, rejectReads = false, rejectSaves = false } = {}) => {

  const writes = [];
  let saveCount = 0;

  return {

    config,
    getPluginConfig: async function() {

      if(this.rejectReads) {

        throw new Error("read failed");
      }

      return this.config;
    },
    rejectReads,
    savePluginConfig: async () => {

      saveCount += 1;

      if(rejectSaves) {

        throw new Error("save failed");
      }
    },
    get saves() {

      return saveCount;
    },
    updatePluginConfig: async (next) => {

      if(reject) {

        throw new Error("write failed");
      }

      writes.push(next);
    },
    writes
  };
};

describe("PluginConfigSession.open", () => {

  test("loads an existing config as the primary entry", async () => {

    const host = makeHost({ config: [{ name: "Existing", platform: "MyPlugin" }] });
    const session = await PluginConfigSession.open({ host, name: "MyPlugin" });

    assert.deepEqual(session.platform, { name: "Existing", platform: "MyPlugin" }, "platform must be the primary entry as loaded");
    assert.equal(session.entries.length, 1, "entries must mirror the loaded array");
  });

  test("seeds the platform name on an empty config without persisting it", async () => {

    const host = makeHost({ config: [] });
    const session = await PluginConfigSession.open({ host, name: "MyPlugin" });

    assert.deepEqual(session.platform, { name: "MyPlugin" }, "the primary entry must be seeded with the platform name");
    assert.equal(host.writes.length, 0, "open must not eagerly persist the seed");
  });

  test("preserves an existing primary entry's name rather than overwriting it", async () => {

    const host = makeHost({ config: [{ name: "Custom Name", platform: "MyPlugin" }] });
    const session = await PluginConfigSession.open({ host, name: "MyPlugin" });

    assert.equal(session.platform.name, "Custom Name", "an existing name must be preserved");
  });
});

describe("PluginConfigSession.commit", () => {

  test("merges a patch onto the primary entry, preserves siblings, and persists the whole array", async () => {

    const host = makeHost({ config: [ { controllers: [{ address: "a" }], name: "P", platform: "MyPlugin" }, { name: "Sibling" } ] });
    const session = await PluginConfigSession.open({ host, name: "MyPlugin" });

    await session.commit({ options: ["Enable.Motion"] });

    assert.equal(host.writes.length, 1, "commit must persist exactly once");
    assert.deepEqual(host.writes[0], [

      { controllers: [{ address: "a" }], name: "P", options: ["Enable.Motion"], platform: "MyPlugin" },
      { name: "Sibling" }
    ], "the patch must merge onto the primary entry, preserving its other fields and the sibling entry");
    assert.deepEqual(session.platform.options, ["Enable.Motion"], "the held reference must advance to the committed state");
  });

  test("a second commit builds on the first commit's held state", async () => {

    const host = makeHost({ config: [{ name: "P", platform: "MyPlugin" }] });
    const session = await PluginConfigSession.open({ host, name: "MyPlugin" });

    await session.commit({ controllers: [{ address: "x" }] });

    assert.deepEqual(session.platform.controllers, [{ address: "x" }], "the first commit must advance the held reference");

    await session.commit({ options: ["O"] });

    assert.deepEqual(session.platform, { controllers: [{ address: "x" }], name: "P", options: ["O"], platform: "MyPlugin" },
      "a second commit must build on the first commit's held state, not the originally loaded config");
  });

  test("a rejected write throws and leaves the held reference at its last-good state (transactional)", async () => {

    const host = makeHost({ config: [{ name: "P", options: ["Original"], platform: "MyPlugin" }], reject: true });
    const session = await PluginConfigSession.open({ host, name: "MyPlugin" });

    await assert.rejects(session.commit({ options: ["New"] }), /write failed/, "a failed write must propagate to the caller");

    assert.deepEqual(session.platform.options, ["Original"], "the held reference must not advance when the write fails");
  });
});

describe("PluginConfigSession.persist", () => {

  test("calls through to the host's savePluginConfig once per call and stages nothing of its own", async () => {

    const host = makeHost({ config: [{ name: "P", platform: "MyPlugin" }] });
    const session = await PluginConfigSession.open({ host, name: "MyPlugin" });

    assert.equal(host.saves, 0, "precondition: opening a session must not save");

    await session.persist();

    assert.equal(host.saves, 1, "persist must call savePluginConfig exactly once");
    assert.equal(host.writes.length, 0, "persist must save what is already staged rather than staging anything itself");

    await session.persist();

    assert.equal(host.saves, 2, "a second persist must call through again - the conduit holds no state that could swallow a repeat save");
  });

  test("leaves the replica reference and its contents identical", async () => {

    const host = makeHost({ config: [{ name: "P", options: ["Original"], platform: "MyPlugin" }] });
    const session = await PluginConfigSession.open({ host, name: "MyPlugin" });
    const entriesBefore = session.entries;
    const platformBefore = session.platform;

    await session.persist();

    assert.equal(session.entries, entriesBefore, "persist must not advance the held reference");
    assert.equal(session.platform, platformBefore, "persist must not rebuild the primary entry");
    assert.deepEqual(session.platform, { name: "P", options: ["Original"], platform: "MyPlugin" }, "persist must leave the replica's contents exactly as they were");
  });

  test("a rejected save propagates and leaves the session usable, so a subsequent commit still works", async () => {

    const host = makeHost({ config: [{ name: "P", options: ["Original"], platform: "MyPlugin" }], rejectSaves: true });
    const session = await PluginConfigSession.open({ host, name: "MyPlugin" });
    const entriesBefore = session.entries;

    await assert.rejects(session.persist(), /save failed/, "a failed save must propagate to the caller");

    assert.equal(host.saves, 1, "the failed save must still have reached the host");
    assert.equal(session.entries, entriesBefore, "a failed save must not move the held reference");
    assert.deepEqual(session.platform.options, ["Original"], "a failed save must not disturb the replica's contents");

    // The session holds nothing a failed save could have left half-applied, so the next stage lands exactly as it would have before the failure.
    await session.commit({ options: ["New"] });

    assert.deepEqual(host.writes, [[{ name: "P", options: ["New"], platform: "MyPlugin" }]], "a commit after a failed save must stage the whole array as usual");
    assert.deepEqual(session.platform.options, ["New"], "the commit after a failed save must advance the replica exactly as it always does");
  });
});

describe("PluginConfigSession.sync", () => {

  test("re-reads the host config so an external edit made between open() and sync() is reflected", async () => {

    const host = makeHost({ config: [{ name: "P", options: ["Original"], platform: "MyPlugin" }] });
    const session = await PluginConfigSession.open({ host, name: "MyPlugin" });

    assert.deepEqual(session.platform.options, ["Original"], "the replica must reflect the host config as of open()");

    // Simulate a Settings-tab edit landing in the host's in-memory config while the page was hidden. We reassign to a NEW array rather than mutating in place: the
    // session's platform getter aliases the previously-held array, so an in-place mutation would be vacuously visible without sync() having done anything.
    host.config = [{ name: "P", options: ["Edited.In.Settings"], platform: "MyPlugin" }];

    await session.sync();

    assert.deepEqual(session.platform.options, ["Edited.In.Settings"], "sync() must advance the replica to the externally edited host config");
  });

  test("re-seeds the minimum { name } shape when the host config is emptied between open() and sync()", async () => {

    const host = makeHost({ config: [{ name: "P", platform: "MyPlugin" }] });
    const session = await PluginConfigSession.open({ host, name: "MyPlugin" });

    // The host config is cleared out from under the session (a user removed the platform block in the Settings tab). sync() must re-seed the bare entry rather than
    // leave the replica with an empty primary entry that downstream readers would have to guard against.
    host.config = [];

    await session.sync();

    assert.deepEqual(session.platform, { name: "MyPlugin" }, "sync() against an emptied host must re-seed the primary entry with the platform name");
    assert.equal(session.entries.length, 1, "the re-seeded replica must hold exactly one bare entry");
    assert.equal(host.writes.length, 0, "sync() must not eagerly persist the re-seeded shape");
  });

  test("a rejected getPluginConfig() during sync() throws and leaves the prior replica intact", async () => {

    const host = makeHost({ config: [{ name: "P", options: ["Original"], platform: "MyPlugin" }] });
    const session = await PluginConfigSession.open({ host, name: "MyPlugin" });

    // The next read fails. sync() reads into a local before advancing the held reference, so a failed read propagates without moving the replica off its last-good
    // state - the page that catches the rejection still has a coherent prior config to fall back on.
    host.rejectReads = true;

    await assert.rejects(session.sync(), /read failed/, "a failed read must propagate to the caller");

    assert.deepEqual(session.platform.options, ["Original"], "the held reference must not advance when the read fails");
  });
});

describe("PluginConfigSession - the config-write generation", () => {

  // A host whose reads are held open by the test. Each getPluginConfig call parks a deferred keyed by the value it will eventually resolve, so a test can start two
  // reads and settle them in whatever order the race it is pinning requires - the shape a slow page cycle's read resolving after a newer one takes in the field. Its
  // writes and saves settle immediately; each records what a generation test needs to see, the payloads on `writes` and the call count on `saves`.
  const makeGatedHost = () => {

    const gates = [];
    const writes = [];
    let saveCount = 0;

    return {

      gates,
      getPluginConfig: () => {

        const gate = Promise.withResolvers();

        gates.push(gate);

        return gate.promise;
      },
      savePluginConfig: async () => {

        saveCount += 1;
      },
      get saves() {

        return saveCount;
      },
      updatePluginConfig: async (next) => {

        writes.push(next);
      },
      writes
    };
  };

  test("a stale sync's late resolution never overwrites a fresher sync's config", async () => {

    const host = makeGatedHost();
    const session = new PluginConfigSession(host, "MyPlugin");

    // Two overlapping reads: the first belongs to a page cycle the user has already left, the second to the cycle now on screen.
    const stale = session.sync();
    const fresh = session.sync();

    // The fresh read lands first and owns the replica.
    host.gates[1].resolve([{ name: "P", options: ["Fresh"], platform: "MyPlugin" }]);
    await fresh;

    assert.deepEqual(session.platform.options, ["Fresh"], "precondition: the fresher read applied");

    // Then the stale read finally answers, carrying what the server said before. Applying it would roll the replica backwards.
    host.gates[0].resolve([{ name: "P", options: ["Stale"], platform: "MyPlugin" }]);
    await stale;

    assert.deepEqual(session.platform.options, ["Fresh"], "the stale read's late resolution must be discarded, not applied over the fresher one");
  });

  test("a stale sync's late resolution never overwrites a just-committed edit", async () => {

    const host = makeGatedHost();
    const session = new PluginConfigSession(host, "MyPlugin");

    // Establish the replica, then start a read that will answer late.
    const open = session.sync();

    host.gates[0].resolve([{ name: "P", options: ["Original"], platform: "MyPlugin" }]);
    await open;

    const stale = session.sync();

    // The user saves an edit while that read is still in flight. The write advances the generation as it applies.
    await session.commit({ options: ["Saved.By.The.User"] });

    assert.deepEqual(session.platform.options, ["Saved.By.The.User"], "precondition: the commit applied");

    // The in-flight read now answers with the pre-save config. Applying it would silently discard the user's save from the replica every later reader sees.
    host.gates[1].resolve([{ name: "P", options: ["Original"], platform: "MyPlugin" }]);
    await stale;

    assert.deepEqual(session.platform.options, ["Saved.By.The.User"], "the read that began before the save must not roll the replica back over it");
    assert.equal(host.writes.length, 1, "the guard changes nothing about what was written");
  });

  test("a persist while a read is in flight leaves that read free to apply - only a write moves the generation", async () => {

    const host = makeGatedHost();
    const session = new PluginConfigSession(host, "MyPlugin");

    // Establish the replica, then start a read that will answer while a save is in the way.
    const open = session.sync();

    host.gates[0].resolve([{ name: "P", options: ["Original"], platform: "MyPlugin" }]);
    await open;

    const inFlight = session.sync();

    // Saving the host's staged config changes what the host has on disk, not what the session holds, so it has no newer truth to defend and must leave the read's
    // generation where it was. That is the contrast with a commit, which holds newer truth and legitimately overtakes an in-flight read.
    await session.persist();

    assert.equal(host.saves, 1, "precondition: the save reached the host");

    host.gates[1].resolve([{ name: "P", options: ["Fresh"], platform: "MyPlugin" }]);
    await inFlight;

    assert.deepEqual(session.platform.options, ["Fresh"], "a read that only a save overlapped must still apply - persist must not advance the write generation");
    assert.equal(host.writes.length, 0, "persist must stage nothing");
  });

  test("a sole sync still applies - the guard drops only reads a later write overtook", async () => {

    const host = makeGatedHost();
    const session = new PluginConfigSession(host, "MyPlugin");
    const sole = session.sync();

    host.gates[0].resolve([{ name: "P", options: ["Applied"], platform: "MyPlugin" }]);
    await sole;

    assert.deepEqual(session.platform.options, ["Applied"], "an uncontested read advances the replica exactly as it always did");

    // And a second, equally uncontested read afterwards applies too, so the generation counter never starves a sequential caller.
    const next = session.sync();

    host.gates[1].resolve([{ name: "P", options: ["Applied.Again"], platform: "MyPlugin" }]);
    await next;

    assert.deepEqual(session.platform.options, ["Applied.Again"], "sequential reads each apply in turn");
  });
});
