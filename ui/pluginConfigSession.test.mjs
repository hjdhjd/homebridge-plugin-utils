/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui/pluginConfigSession.test.mjs: Unit tests for the PluginConfigSession config owner.
 */
"use strict";

import { describe, test } from "node:test";
import { PluginConfigSession } from "./pluginConfigSession.mjs";
import assert from "node:assert/strict";

// Minimal host stub matching the {getPluginConfig, updatePluginConfig} surface the session uses. getPluginConfig returns the host's CURRENT `config` backing - exposed
// as a settable field on the returned host so a test can reassign it to a new array between open() and sync() to simulate an external Settings-tab edit; in-place
// mutation of the same array would be vacuous, since session.platform aliases that reference. updatePluginConfig records every payload and can be made to reject so
// the transactional-commit contract is exercisable. `rejectReads` lets a test fail the sync() read path independently of the write path.
const makeHost = ({ config = [], reject = false, rejectReads = false } = {}) => {

  const writes = [];

  return {

    config,
    getPluginConfig: async function() {

      if(this.rejectReads) {

        throw new Error("read failed");
      }

      return this.config;
    },
    rejectReads,
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
