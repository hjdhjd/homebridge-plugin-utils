/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui/webUi-saveFlow.mjs: The shared save flow for plugin settings cards - a check, at most one write, and one delivery decision for every press of a card's Save.
 */

/**
 * The webUI's save flow: the one path from a press of a settings card's Save to the outcome the user is told, so the rules that make a Save trustworthy live in
 * one place rather than in a copy composed by hand at every card.
 *
 * A card's Save checks what the user entered, writes it through the page's configuration commit, and reports what became of it. The flow holds every press to
 * the same rules: a press that arrives while a write is in flight starts nothing, a Save whose composer answers null - its change already in place, or refused
 * against the configuration as it stands - writes nothing of the composer's and is answered as such, and an outcome the user is owed lands on the card while
 * the card still shows that Save and on a toast otherwise. {@link createSaveFlow} builds one flow per card, and its `save` answers a tagged
 * {@link SaveFlowResult} the card switches on.
 *
 * The flow owns no guard. A card has one way of beginning an action, which its other actions - a probe, a validation - use too, and a Save must retire them and
 * be retired by them. That holds only when the Save begins through the same starter, so the card injects its starter and the flow never mints a lifetime of its
 * own. What the flow does own is the one fact no single action can hold, whether a write is in flight, and a press that arrives during one is answered `busy`
 * rather than queued behind it or allowed to retire it: a write cannot be recalled once it has started, and a second write is the defect itself.
 *
 * The module reaches for no document, holds no store and no plugin knowledge, and imports nothing: the commit, the starter, the toast, and the card's Save
 * control all arrive by injection, which is also what lets a consumer's suite drive the real flow with its own doubles. Policy stays with the card - what it
 * checks, what it writes, what a busy press looks like, and the copy and the after-work of a success. The Save control's disabled state during a write is the
 * flow's, so a Save that could not be honored is not pressable on any card.
 *
 * @module
 */
"use strict";

/**
 * What a card's action starter answers for each action it begins. Of it the flow reads only `signal`, which aborts the moment the card retires the action, and
 * `presented()`, which says whether the card still shows what it showed when the action began. Whatever else the answer carries is the card's own, and the flow
 * hands the whole object back as the press's `action`, so a card reaches what it captured at the press - a takeover handle above all - on the result of that
 * same press rather than through state it keeps beside the flow.
 *
 * @typedef {Object} SaveAction
 * @property {() => boolean} presented - Whether the card still shows what it showed when the action began, read at the moment it is called.
 * @property {AbortSignal} signal - The action's lifetime on the card, aborted when the card retires the action.
 */

/**
 * The one delivery decision for an outcome the user is owed. It paints on the card while the press is presented. Otherwise it raises the named toast, because a
 * card that closed or moved on is still owed the outcome, and so is any press whose write started - with one exception: a press retired before its write owes the
 * user nothing, so for it the delivery does nothing at all.
 *
 * It is for outcomes. A progress paint made during the check reads `presented()` instead and is dropped when that answers false, since progress on a card the
 * user cannot see is owed to nobody. An outcome always goes through here and never through a paint helper the action carries, because a helper that drops what
 * the card does not present would drop an outcome the user is owed along with it.
 *
 * @typedef {(delivery: { channel: ("error" | "info" | "success" | "warning"), paint: () => void, text: string }) => void} SaveDelivery
 */

/**
 * What a check receives: the press's `action` exactly as the starter answered it, that action's `signal`, `presented()`, true while the signal is live and the
 * card's own `presented()` answers true, and `deliver`, the press's delivery decision.
 *
 * Nothing a check runs may begin another action on the same card, a call to the card's own starter included: beginning one retires the press the check belongs
 * to, which then resolves `superseded` with nothing written.
 *
 * @typedef {Object} SaveActionContext
 * @property {SaveAction} action - The starter's answer for this press.
 * @property {SaveDelivery} deliver - The press's delivery decision.
 * @property {() => boolean} presented - Whether the press is still presented, read at the moment it is called.
 * @property {AbortSignal} signal - The press's signal, for every await the check bounds.
 */

/**
 * What a check answers: `passed` with the value the write composes with, or `declined` with the reason it refused. Only a passed check writes, and any other
 * answer is a bug in the check that rejects the press.
 *
 * A check that delivers its own refusal answers `declined` with a reason the card does not deliver again, and a check that delivers nothing leaves the reason to
 * the card, which delivers it from the result. One refusal is delivered once.
 *
 * @typedef {{ kind: "passed", value: * } | { kind: "declined", reason: * }} SaveCheckResult
 */

/**
 * What became of a press, tagged by `kind`:
 *
 *   - `busy`: a write was already in flight, so the press started nothing and left the write's own presentation alone. What a refused press looks like is the
 *     card's to decide, and nothing is owed.
 *   - `superseded`: the press was retired before its write - by a later press, by another of the card's actions, or by whatever bounds the card's guard.
 *     Nothing was written, and nothing is owed, because the action that retired it owns the card.
 *   - `declined`: the check refused, carrying its `reason`, and nothing was written. A card whose check delivered nothing delivers the reason through `deliver`.
 *   - Every other kind is the page's commit result, passed through with its `error` where it has one and with the checked `value` added. A card delivers
 *     `failed` and `unchanged` through `deliver`, because the press reached its write and its outcome is owed. `unchanged` means the composer answered null,
 *     its change already in place or refused against the configuration as it stands, and the result does not say which: the card supplies the words, and a
 *     card whose composer answers null for more than one reason keeps the reason in a variable its composer sets. Success is left to the card, because its copy and its
 *     after-work are plugin policy, and a card that saves releases its own takeover.
 *
 * Each member but `busy` and `superseded` carries the press's `action`, `deliver` and `presented`, so a card delivers and releases from the result alone.
 *
 * @typedef {{ kind: "busy" } | { kind: "superseded" } | ({ action: SaveAction, deliver: SaveDelivery, presented: () => boolean } &
 *   ({ kind: "declined", reason: * } | ({ value: * } & import("./webUi-featureOptions.mjs").CommitConfigResult)))} SaveFlowResult
 */

/**
 * Create the save flow for one settings card.
 *
 * The flow's whole state across presses is whether a write is in flight, one boolean in this closure, so a flow belongs to the card it serves: each card runs
 * its own flow, and none refuses a press on account of another card's write. Everything else a press needs arrives by injection, which keeps the flow free of any page,
 * card, or host it would otherwise have to reach for.
 *
 * Whatever bounds the starter's signal decides whether closing the card retires a Save before its write. A card whose guard takes the card's own lifetime as its
 * parent retires a pressed Save when it closes; a card that wants a close to leave a pressed Save running gives its guard no parent tied to the card, and
 * `presented()` then decides only where the outcome lands. A press that has reached its write is retired by nothing: the write runs to its result, and that
 * result is owed.
 *
 * The card's Save control is not pressable for exactly the span in which a press could not be honored, which is the library's default for every card. The span
 * starts when the commit is called and ends when the commit settles, on every way out, a rejection included. The control is not disabled during the check,
 * because a newer press retires a check and the user must be able to make one. The busy answer is what guarantees a second write never starts, and the
 * disabled control is a courtesy on top of it, not the safety mechanism. The option is required and may be null, so a card with no Save control says so on
 * purpose rather than by leaving it out. The flow asks of the control only its `disabled` flag and restores the state it found, so a control the card had
 * disabled for its own reason stays disabled. The restore writes over whatever the card set on the control during the write, so a card that manages the
 * control itself sets it again when it handles the result. A control serves one flow, for that flow's life.
 *
 * The flow puts no bound on a write, so the control stays disabled for as long as the write is outstanding, which is the truth of the card's state. The commit a
 * card injects settles only when the page's commit settles, with no deadline wrapped around it, because a deadline would clear the in-flight flag and
 * re-enable the control while the write still runs.
 *
 * @param {Object} options
 * @param {import("./webUi-featureOptions.mjs").webUiFeatureOptions["commitConfig"]} options.commit - The page's configuration commit, which a page passes as a
 *   function calling its feature-options instance's `commitConfig`.
 * @param {{ disabled: boolean } | null} options.control - The card's Save control, which the flow disables for the span of each write, or null for a card that
 *   has none. A button element serves, as does any object whose `disabled` flag is a boolean.
 * @param {() => SaveAction} options.start - The card's own way of beginning an action. It retires whatever action the card had in flight, exactly as the card's
 *   other actions do, and answers the new action's signal and `presented()`. A card whose guard is its only press state passes a closure over `guard.start()`;
 *   a card that also blanks its verdict line and captures what it is showing passes the function that does all of that, once it answers `presented` and
 *   `signal`.
 * @param {{ error: (message: string) => void, info: (message: string) => void, success: (message: string) => void, warning: (message: string) => void }}
 *   options.toast - The host's toast, which the flow calls only through a press's delivery decision.
 * @returns {{ save: (request: { check: (context: SaveActionContext) => (SaveCheckResult | Promise<SaveCheckResult>), compose: (platform: Object, value: *) =>
 *   Object | null, rename?: import("./webUi-featureOptions/state.mjs").ControllerRename }) => Promise<SaveFlowResult> }} The card's flow: `save` runs one press.
 * @throws {TypeError} When `control` is neither null nor an object whose `disabled` flag is a boolean, an omitted control included.
 */
export const createSaveFlow = ({ commit, control, start, toast }) => {

  // A card states its Save control at construction or states that it has none, so a missing control is refused here rather than discovered at the first write.
  if((control !== null) && (typeof control?.disabled !== "boolean")) {

    throw new TypeError("A save flow requires a control, the card's Save control with a boolean disabled flag, or null for a card that has none.");
  }

  // Whether a write is in flight, the flow's whole state across presses. Only the press that starts a write sets it and only that press's finally clears it, so a
  // busy press, which does neither, can never release a write it did not start.
  let writing = false;

  /**
   * Run one press of the card's Save.
   *
   * A press that arrives while a write is in flight answers `busy` before it begins anything, so it neither retires the write's action nor blanks what the card
   * is showing. Otherwise the press begins its action through the card's starter, synchronously within this call, and runs the check under the card's
   * newest-wins rule: a press the card retires while its check runs resolves `superseded`, and its delivery does nothing. No await separates the read of the
   * signal after the check from the write, so that read is the last point a retired press stops; past it, the write runs to its result and the result is owed.
   *
   * The commit is called at most once per press, and the composer only inside it. The composer is where work that must immediately precede the write belongs:
   * it runs once, after the page's own pending edits are written, under the page's hold when the page took one, and directly before the write. A composer
   * answers null when its change is already in place, and also to refuse the change against the configuration as it stands, a duplicate of an entry another
   * call wrote ahead of it being the case that needs the composer's view. It refuses by that answer and never by a throw, because a composer that throws is a
   * bug in the card's own code and rejects the press. A card that prepares something there undoes it on every outcome that left the composer's change
   * unwritten - `failed`, `unchanged`, and a rejected press - and does not assume the composer ran, because `failed` can answer before it does. A card that
   * prepared something inside its check undoes it on `superseded` too, since the flow wrote nothing but cannot know what the check did.
   *
   * A press rejects only for a bug in the caller's own code: a malformed call, a starter answer without its members, a check that throws or answers something
   * other than passed or declined while its press is current, a Save control whose `disabled` flag throws, and a commit that rejects, which the commit does only
   * for a composer that throws or a malformed call, before any write starts. The in-flight flag is cleared on every path out of a write, so a rejected press
   * never leaves the card unable to save.
   *
   * @example
   *
   * // One flow per card, built beside the card's guard. The card's starter blanks its verdict line, begins an action on the guard, and answers the action's
   * // signal, the presented() rule the card keeps, and the takeover the card is mounted in. The card's Save button is the control the flow disables during a write.
   * const flow = createSaveFlow({
   *
   *   commit: (compose, options) => featureOptions.commitConfig(compose, options),
   *   control: card.saveButton,
   *   start: card.start,
   *   toast: homebridge.toast
   * });
   *
   * const onSave = async () => {
   *
   *   const result = await flow.save({
   *
   *     check: async ({ signal }) => {
   *
   *       try {
   *
   *         const answer = await withDeadline({ promise: homebridge.request("/probe", card.values()), seconds: 10, signal });
   *
   *         return answer.ok ? { kind: "passed", value: answer.controller } : { kind: "declined", reason: answer.message };
   *       } catch(error) {
   *
   *         // A press retired meanwhile is answered superseded by the flow, whatever this check returns.
   *         return { kind: "declined", reason: errorMessage(error) };
   *       }
   *     },
   *     compose: (platform, controller) => platform.controllers.some((entry) => entry.address === controller.address) ? null :
   *       { controllers: [ ...platform.controllers, controller ] }
   *   });
   *
   *   switch(result.kind) {
   *
   *     case "busy":
   *     case "superseded": {
   *
   *       return;
   *     }
   *
   *     case "declined": {
   *
   *       result.deliver({ channel: "error", paint: () => card.verdict(result.reason), text: result.reason });
   *
   *       return;
   *     }
   *
   *     case "unchanged": {
   *
   *       const text = "A controller at this address is already saved.";
   *
   *       result.deliver({ channel: "info", paint: () => card.verdict(text), text });
   *
   *       return;
   *     }
   *
   *     case "failed": {
   *
   *       result.deliver({ channel: "error", paint: () => card.verdict(errorMessage(result.error)), text: errorMessage(result.error) });
   *
   *       return;
   *     }
   *
   *     case "committed": {
   *
   *       homebridge.toast.success("The controller was saved.");
   *       result.action.takeover.release();
   *
   *       return;
   *     }
   *
   *     case "staged": {
   *
   *       homebridge.toast.warning("The controller was written but not saved to disk. Save the plugin settings to keep it.");
   *       result.action.takeover.release();
   *
   *       return;
   *     }
   *   }
   * };
   *
   * @param {Object} request
   * @param {(context: SaveActionContext) => (SaveCheckResult | Promise<SaveCheckResult>)} request.check - Checks what the user entered under the press's action and
   *   answers whether to write. It receives the press's context and may deliver through it.
   * @param {(platform: Object, value: *) => Object | null} request.compose - Composes the patch from the live platform entry and the checked value, answering null
   *   when the change is already in place or to refuse it against the configuration as it stands.
   * @param {import("./webUi-featureOptions/state.mjs").ControllerRename} [request.rename] - The controller rename the write declares, handed to the commit as given:
   *   the commit owns its shape and refuses a malformed one.
   * @returns {Promise<SaveFlowResult>} What became of the press.
   * @throws {TypeError} When `check` or `compose` is not a function.
   * @throws {TypeError} When the starter's answer has no `presented()` function or no `AbortSignal`.
   * @throws {TypeError} When a current press's check answers something other than passed or declined.
   */
  const save = async ({ check, compose, rename = undefined }) => {

    // The caller bugs, refused before anything else so neither can begin an action or be mistaken for an outcome. The rename is not examined: the commit owns its
    // shape and refuses a malformed one itself, and a second copy of that test here would be a second thing to keep in step.
    if((typeof check !== "function") || (typeof compose !== "function")) {

      throw new TypeError("A save requires a check function, answering whether to write, and a compose function, answering a patch or null.");
    }

    // A write is in flight, so this press starts nothing. Beginning an action would retire the write's own, and its owed outcome would then reach a toast while
    // the card still shows it.
    if(writing) {

      return { kind: "busy" };
    }

    // Begin the press's action ahead of the first await, so the press retires whatever the card had in flight at the moment of the press rather than a turn later.
    const action = start();

    if((typeof action?.presented !== "function") || !(action?.signal instanceof AbortSignal)) {

      throw new TypeError("A save flow's start must answer the action it began with a presented() function and the action's AbortSignal.");
    }

    const { signal } = action;

    // A card whose guard has outlived its parent lifetime begins every action already retired, and such a press has nothing to check.
    if(signal.aborted) {

      return { kind: "superseded" };
    }

    // Whether this press has reached its write, set once just before the commit is called and never cleared: from that moment the outcome is owed, whatever
    // becomes of the action.
    let wrote = false;

    /**
     * Whether the press is presented, read at the moment of the call rather than at the press. The signal is read here rather than left to the card's own
     * answer, so a card's `presented()` need only say what the card shows.
     *
     * @returns {boolean} True while the press's signal is live and the card still shows what it showed when the action began.
     */
    const presented = () => !signal.aborted && action.presented();

    /**
     * Deliver an outcome under the rule {@link SaveDelivery} states. Presentation and the write mark are each read at the call, so an outcome delivered after
     * the card moved on reaches the toast, and one delivered by a press retired before its write reaches nothing.
     *
     * @type {SaveDelivery}
     */
    const deliver = ({ channel, paint, text }) => {

      if(presented()) {

        paint();

        return;
      }

      // A press retired before its write owes the user nothing: whatever it would report answers for input the card has already moved past.
      if(!wrote && signal.aborted) {

        return;
      }

      toast[channel](text);
    };

    let verdict;

    try {

      verdict = await check({ action, deliver, presented, signal });
    } catch(error) {

      // A check that fails after its press was retired is answering for input the user has already moved past...the press is superseded, not broken.
      if(signal.aborted) {

        return { kind: "superseded" };
      }

      throw error;
    }

    // The last point a retired press stops. No await separates this read from the write below, so a press that passes it cannot be retired before it writes.
    if(signal.aborted) {

      return { kind: "superseded" };
    }

    if(verdict?.kind === "declined") {

      return { action, deliver, kind: "declined", presented, reason: verdict.reason };
    }

    if(verdict?.kind !== "passed") {

      throw new TypeError("A save check must answer with kind passed and the value to write, or with kind declined and the reason it refused.");
    }

    const { value } = verdict;

    // The write starts. The press is marked and the flag set in the same turn as the call, and the finally clears the flag on every way out, a rejection included,
    // so the card can always save again once this write has settled.
    wrote = true;
    writing = true;

    // The control's `disabled` flag as this press found it, and the value the finally restores. It stays undefined when there is no control or when reading the
    // flag threw, and then the press restores nothing.
    let found;

    try {

      /* The control is disabled in the same turn that makes a later press answer busy, ahead of the commit with no await between, so there is no moment in which
       * the card offers a Save the flow would refuse. The read and the write sit inside the try because the control belongs to the card: one whose flag throws
       * rejects the press, and the finally still clears the in-flight flag.
       */
      if(control !== null) {

        found = control.disabled;
        control.disabled = true;
      }

      const result = await commit((platform) => compose(platform, value), { rename });

      return { ...result, action, deliver, presented, value };
    } finally {

      // The in-flight flag is cleared before the control is touched, so a restore that throws rejects the press without leaving the card unable to save.
      writing = false;

      if(found !== undefined) {

        control.disabled = found;
      }
    }
  };

  return { save };
};
