/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webui/commit.ts: The vocabulary of the feature-options page's coordinated configuration write.
 */

/**
 * The vocabulary of the feature-options page's coordinated configuration write: the call itself, the controller rename a call may declare, and what became of it.
 *
 * The page's `commitConfig` is the one writer behind this contract. A plugin's settings card calls it directly or hands it to the shared save flow, and types
 * against these declarations from the package root rather than restating them. The module declares types alone, so it compiles to nothing the browser loads, and
 * the page's own JavaScript names these types by this source file's path.
 *
 * @module
 */

/**
 * What became of a {@link CommitConfig} call: one member per thing a consumer does about it, tagged by `kind` because the members are mutually exclusive answers to
 * one question, and a member that answers for a refusal carries the error that explains it.
 *
 * `committed` and `staged` both mean the configuration changed and the page has been reconciled to it, so a consumer updates its own caches identically for the
 * two and differs only in what it tells the user: `staged` reached the host's memory and failed to reach disk, which the user's own Save still completes.
 * `failed` means the composer's change was not written - a pending option edit never reached the host, or the host refused the write. `unchanged` means the
 * composer answered null, so nothing of the composer's was written. A composer answers null when its change is already in place, and also when it refuses the
 * change against the configuration as it stands. The result does not say which, because the plugin that wrote the composer knows, and a consumer whose
 * composer can answer null for more than one reason keeps the reason in a variable the composer sets. Whatever the reason, the page is neither re-established
 * nor re-entered, a consumer has no cache to update, and what it tells the user is the reason its composer answered null. What `failed` and `unchanged` leave
 * unwritten is the composer's change alone: a pending option edit the call drained ahead of the composer stays written.
 *
 * @category WebUI Commit
 */
export type CommitConfigResult =
  { readonly kind: "committed" } |
  { readonly error: unknown; readonly kind: "staged" } |
  { readonly error: unknown; readonly kind: "failed" } |
  { readonly kind: "unchanged" };

/**
 * One controller key becoming another. The page keys a controller by the `serialNumber` its plugin's `getControllers` hook supplies, and a plugin that fills it
 * from configuration - the controller's address, above all - replaces the key whenever a write edits that configuration. Nothing in the two lists says the
 * departing key and the arriving one are the same controller, so a write that replaced one declares it, naming the key the controller had and the key it has now.
 *
 * The declaration is a claim about the write, and the controller lists on either side of it are the evidence: the page's `renameHonored` is the one test of
 * whether they prove it, and a rename they do not prove is ignored.
 *
 * @category WebUI Commit
 */
export interface ControllerRename {

  /**
   * The key the controller had before the write.
   */
  readonly from: string;

  /**
   * The key the controller has after the write.
   */
  readonly to: string;
}

/**
 * The page's coordinated configuration write, as a function: the feature-options page's own `commitConfig`, or the function a card is handed in its place, which a
 * page writes as a call to its feature-options instance's `commitConfig`. That method states the whole contract - the calls serialized, a pending option edit
 * written ahead of the composer, and the page reconciled to what was written.
 *
 * @typeParam TPlatform - The platform configuration object the composer receives. A plugin names its own configuration type here so its composer reads the entry
 *   as that type; it is `object` for a caller that names none.
 *
 * @param compose          - Synchronous composer receiving the live primary platform entry and returning the patch to merge onto it, or null when its change is
 *                           already in place or when it refuses the change. The entry is the composer's to read and not to edit: the page's store holds its options
 *                           array by reference.
 * @param options          - The call's options, which a card that declares no rename leaves out.
 * @param options.rename   - The controller this call renames, as the sidebar key it had and the key it has now. The page carries every settled fact naming the old
 *                           key onto the new one once the controller lists on either side of the call prove the rename, and ignores one they do not prove. Absent
 *                           declares none.
 *
 * @returns What became of the write, and what the page did about it.
 *
 * @category WebUI Commit
 */
export type CommitConfig<TPlatform extends object = object> =
  (compose: (platform: TPlatform) => object | null, options?: { readonly rename?: ControllerRename }) => Promise<CommitConfigResult>;
