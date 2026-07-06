/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * pluginConfigSession.mjs: Session-scoped owner of the persisted plugin configuration.
 */
"use strict";

/**
 * PluginConfigSession - the single session-scoped accessor to the persisted plugin configuration, holding a coherent replica of the host config.
 *
 * The webUI needs to read its plugin configuration at several lifecycle points (routing, the first-run flow, the feature-options page) and to write it at two
 * (first-run credential capture, feature-option saves). Left to themselves, each of those sites would call `homebridge.getPluginConfig` independently and at least
 * two would call `homebridge.updatePluginConfig` independently - several conduits to the same host config, each free to read it at a different moment and to drift
 * from the others. This owner collapses that to one: every read and every write of the host config goes through this single accessor, so the held array is the one
 * copy the session reasons about.
 *
 * The host config is the ultimate source of truth; this class is not a second source but the one correct accessor to the first, holding a replica that is coherent
 * as of its last reference-advancing operation. The held replica advances only through {@link sync} (the read-direction advance, re-reading the host config) and
 * {@link commit} (the write-direction advance, persisting an edit). Routing, the first-run hooks, and the feature-options page all receive their config from here, and
 * nothing else calls the host config endpoints.
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
 * }
 */
export class PluginConfigSession {

  // The held config array - the session's coherent replica of the plugin configuration. Read through the getters; advanced by sync() (read) and commit() (write).
  #config;

  // The Homebridge UI host (or a test stub matching the {getPluginConfig, updatePluginConfig} surface). The session is the only place that calls its config endpoints.
  #host;

  // The platform name used to seed the minimum config shape when the host has none. Preserved on the primary entry across commits.
  #name;

  /**
   * Open a configuration session: read the host config into the replica via the initial {@link sync} and seed a minimal primary platform entry when it is absent, so
   * every downstream reader sees a well-formed entry rather than having to guard for the empty-first-run case. Subsequent entries re-sync the replica, so this opening
   * read establishes the replica rather than freezing it.
   *
   * @param {Object} args
   * @param {{getPluginConfig: () => Promise<Object[]>, updatePluginConfig: (config: readonly Object[]) => Promise<unknown>}} args.host - The Homebridge bridge.
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
   * Merge a patch into the primary platform entry and persist the whole array (sibling entries preserved), advancing the held reference only after the host write
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

    this.#config = next;
  }

  /**
   * Re-read the host config into the replica and seed the minimum shape. Every configuration read funnels through this method, pairing with {@link commit} as the
   * read-direction half.
   *
   * Called on every page entry so the replica re-reads against any external Settings-tab edit before the page renders against it. An empty host result yields a
   * single bare entry; in both cases we ensure the primary entry carries the platform name so a later commit persists a well-formed block. The seed is held only -
   * never eagerly written - so a fresh install that is opened and abandoned never leaves a bare platform entry staged on the host; the first real commit persists the
   * name alongside actual data.
   *
   * Built like {@link commit} for symmetry and clarity: the read happens into a local, the local is seeded, and a single trailing assignment advances the held
   * reference. (The build-then-assign is not load-bearing against a torn write here - the only I/O is the first statement - but it keeps this method's shape
   * consistent with {@link commit}.)
   *
   * @returns {Promise<void>}
   */
  async sync() {

    const loaded = await this.#host.getPluginConfig();
    const next = loaded.length ? loaded : [{}];

    (next[0] ??= { name: this.#name }).name ??= this.#name;

    this.#config = next;
  }
}
