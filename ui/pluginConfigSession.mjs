/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * pluginConfigSession.mjs: Session-scoped owner of the persisted plugin configuration.
 */
"use strict";

/**
 * PluginConfigSession - the single session-scoped accessor to the persisted plugin configuration, holding a coherent replica of the host config.
 *
 * The webUI needs to read its plugin configuration at several lifecycle points (routing, the first-run flow, the feature-options page) and to write it at two
 * (first-run credential capture, feature-option saves). Left to themselves, each of those sites would call `homebridge.getPluginConfig` independently, at least two
 * would call `homebridge.updatePluginConfig` independently, and each writer would pair its own bare `homebridge.savePluginConfig` with it - several conduits to the
 * same host config, each free to read it at a different moment and to drift from the others. This owner collapses that to one: every read, every stage, and every
 * save of the host config goes through this single accessor, so the held array is the one copy the session reasons about.
 *
 * The host config is the ultimate source of truth; this class is not a second source but the one correct accessor to the first, holding a replica that is coherent
 * as of its last reference-advancing operation. The held replica advances only through {@link sync} (the read-direction advance, re-reading the host config) and
 * {@link commit} (the write-direction advance, staging an edit into the host's in-memory model). {@link persist} is the save direction, writing out what is staged,
 * and it advances nothing at all: it changes what the host has on disk, not what the session holds. Routing, the first-run hooks, and the feature-options page all
 * receive their config from here, and nothing else calls the host config endpoints - the read, the stage, and the save alike.
 *
 * Because the host config can change underneath the session while the page is hidden (the Settings tab edits the same in-memory model), the replica is not assumed
 * frozen. The feature-options page re-syncs on every entry ({@link sync} at its `show()` chokepoint), so the replica is re-read against any external Settings-tab
 * edit before the page renders against it. {@link commit} advances the reference transactionally - it moves only after the host write resolves, so a failed write
 * leaves the prior replica intact. This mirrors how Homebridge models its own config: read, edit, save - re-read on the next visit.
 *
 * @example
 *
 * const session = await PluginConfigSession.open({ host: homebridge, name: "My Platform" });
 *
 * if(!session.platform.controllers?.length) {
 *
 *   await session.commit({ controllers: [ { address, password, username } ] });
 *   await session.persist();
 * }
 */
export class PluginConfigSession {

  // The held config array - the session's coherent replica of the plugin configuration. Read through the getters; advanced by sync() (read) and commit() (write).
  #config;

  // The monotonic config-write generation, covering both writers. A sync mints one on entry and applies its result only if the generation has not moved since; a commit
  // moves it when it applies. The session is shared across every page cycle and its reads are bounded rather than cancellable, so a slow read from an earlier cycle can
  // still resolve after a fresher read or a user's save has already landed - this is what keeps that late arrival from putting the replica back to what it read.
  #generation;

  // The Homebridge UI host (or a test stub matching the {getPluginConfig, savePluginConfig, updatePluginConfig} surface). The session is the only place that calls
  // its config endpoints.
  #host;

  // The platform name used to seed the minimum config shape when the host has none. Preserved on the primary entry across commits.
  #name;

  /**
   * Open a configuration session: read the host config into the replica via the initial {@link sync} and seed a minimal primary platform entry when it is absent, so
   * every downstream reader sees a well-formed entry rather than having to guard for the empty-first-run case. Subsequent entries re-sync the replica, so this opening
   * read establishes the replica rather than freezing it.
   *
   * @param {Object} args
   * @param {{getPluginConfig: () => Promise<Object[]>, savePluginConfig: () => Promise<unknown>,
   *   updatePluginConfig: (config: readonly Object[]) => Promise<unknown>}} args.host - The Homebridge bridge.
   * @param {string} [args.name] - The platform name used to seed an empty configuration.
   * @returns {Promise<PluginConfigSession>} The opened session.
   */
  static async open({ host, name }) {

    const session = new PluginConfigSession(host, name);

    await session.sync();

    return session;
  }

  /**
   * @param {Object} host - The Homebridge bridge.
   * @param {string} [name] - The platform name used to seed an empty configuration.
   */
  constructor(host, name) {

    this.#config = [];
    this.#generation = 0;
    this.#host = host;
    this.#name = name;
  }

  /**
   * The full configuration array, exactly as it will be written back to the host. Exposed for the feature-options page, which preserves the sibling entries [1..]
   * when it overlays the live edited options for its editing-buffer view.
   *
   * @returns {readonly Object[]} The plugin-config array.
   */
  get entries() {

    return this.#config;
  }

  /**
   * The primary platform-config entry (config[0]). The live reference the orchestrator injects into every plugin hook; reads happen against this.
   *
   * @returns {Object} The primary platform-config entry.
   */
  get platform() {

    return this.#config[0];
  }

  /**
   * Merge a patch into the primary platform entry and stage the whole array (sibling entries preserved), advancing the held reference only after the host write
   * resolves. Every configuration write funnels through this method; it is the write-direction counterpart of {@link sync}.
   *
   * Transactional by construction: the next array is built and written before it replaces the held reference, so a rejected write throws without moving the session
   * off its last-good state. Callers that need to surface the failure (the persist effect's rollback path) catch the rejection; the session itself stays consistent
   * either way.
   *
   * @param {Object} patch - Fields to merge onto the primary platform entry (e.g. `{ controllers }` or `{ options }`). The primary entry's other fields are preserved.
   * @returns {Promise<void>}
   */
  async commit(patch) {

    const next = [ { ...this.#config[0], ...patch }, ...this.#config.slice(1) ];

    await this.#host.updatePluginConfig(next);

    // Advance the write generation alongside the replica, so a read that began before this save cannot land afterwards and quietly restore the pre-save config.
    this.#generation += 1;
    this.#config = next;
  }

  /**
   * Save the host's staged configuration to disk. Every configuration save funnels through this method, completing the set of acts the session owns: {@link sync}
   * reads the host config, {@link commit} stages an edit into it, and this writes what is staged out to disk.
   *
   * Saving is its own method rather than an option on {@link commit} because staging and saving are separate acts that callers decide between: every consumer runs a
   * liveness check after staging and skips the save when its deadline has passed, leaving the edit staged for the user's own save to pick up. A commit that also
   * saved would leave nowhere for that decision to happen.
   *
   * A thin conduit by construction: it advances neither the replica nor the write generation, because saving persists what is already staged host-side and changes
   * nothing the session holds. Nor does it check that anything was staged - the host saves whatever its in-memory config currently holds, and the session cannot know
   * what else has staged into it (the Settings tab edits the same model), so a guard here would be guessing. A rejected save propagates to the caller, exactly as
   * {@link commit} propagates its own host failure.
   *
   * @returns {Promise<void>}
   */
  async persist() {

    await this.#host.savePluginConfig();
  }

  /**
   * Re-read the host config into the replica and seed the minimum shape. Every configuration read funnels through this method, pairing with {@link commit} as the
   * read-direction half.
   *
   * Called on every page entry so the replica re-reads against any external Settings-tab edit before the page renders against it. An empty host result yields a
   * single bare entry; in both cases we ensure the primary entry carries the platform name so a later commit stages a well-formed block. The seed is held only -
   * never eagerly written - so a fresh install that is opened and abandoned never leaves a bare platform entry staged on the host; the first real commit stages the
   * name alongside actual data.
   *
   * Built like {@link commit} for symmetry and clarity: the read happens into a local, the local is seeded, and a single trailing assignment advances the held
   * reference. (The build-then-assign does not guard against a torn write here - the only I/O is the first statement - but it keeps this method's shape
   * consistent with {@link commit}.)
   *
   * The trailing assignment is conditional on the write generation this read minted at entry. The host read is bounded but not cancellable, so a read from a page cycle
   * the user has already left can still resolve - after a fresher read, or after the user saved an edit - and applying it then would silently roll the replica back to
   * what the server said minutes ago. A read that finds the generation moved simply discards what it loaded; the writer that moved it holds the newer truth.
   *
   * @returns {Promise<void>}
   */
  async sync() {

    // Mint this read's generation before any I/O, so any write that lands while it is in flight is detectable when it returns.
    this.#generation += 1;

    const generation = this.#generation;
    const loaded = await this.#host.getPluginConfig();
    const next = loaded.length ? loaded : [{}];

    (next[0] ??= { name: this.#name }).name ??= this.#name;

    if(this.#generation !== generation) {

      return;
    }

    this.#config = next;
  }
}
