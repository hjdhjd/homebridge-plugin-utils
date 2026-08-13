/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webUi-featureOptions/rendering.mjs: Pure DOM construction for the feature options webUI.
 */
"use strict";

import { createElement, createSvgElement } from "./utils.mjs";
import { hasValueContent, isValueOption, optionExists } from "../featureOptions.js";

/**
 * Pure DOM construction for the feature options webUI.
 *
 * Every export here is a pure function from data to DOM:
 *
 *   - {@link categoryShell} - builds the `<details>` shell for one category (header + empty rows container). Lazy materialization: the rows container is intentionally
 *     empty; the view fills it on first expand to keep initial render bounded by category count, not option count.
 *   - {@link optionRow} - builds one option row's bare structure (checkbox, label, optional value-input) and applies its initial state via {@link applyRowState}.
 *   - {@link applyRowState} - the single writer for every state-dependent attribute of a row (tri-state, value-input state, label color, visibility, dependency
 *     badge), derived from the projection entry. The construction path and the per-mutation update walk both call it, so a freshly-built row and a re-derived row run
 *     identical code - no derived attribute can be set on one path and forgotten on the other. This is what makes the row DOM a pure function of the projection.
 *   - {@link toggleSecretReveal} - flips a masked value input between hidden and shown, and re-labels its toggle to match. The one row-DOM write that answers to a
 *     gesture rather than to the projection: whether a secret is currently on screen is a property of how the page is being read at this moment, not of the
 *     configuration, so no action is computed and nothing is dispatched.
 *   - {@link triStateTransition} - the click-time state machine. Given the current DOM state of a checkbox plus the projection entry and configuration, computes only
 *     the action to dispatch. The resulting DOM state is not returned: the dispatch updates the store, and the view re-derives the row through {@link applyRowState}
 *     against the post-dispatch projection. Pure - takes data, returns data.
 *   - {@link valueCommitTransition} - the input-side counterpart for value-centric rows. Given the committed text plus the projection entry and configuration,
 *     computes the action to dispatch, or none when the commit has nothing to say. Same discipline: pure, no DOM writes, the view dispatches and re-derives.
 *
 * The functions take projection entries (the view-relative records built by {@link projection}), the current view's scope kind, and any view-context identifiers
 * they need (controllerId, deviceId). They do not read from a store, do not subscribe to events, do not call selectors. The view layer assembles the inputs and
 * applies the outputs.
 *
 * Splitting the tri-state click logic out as a pure function ({@link triStateTransition}) means the inheritance state machine's action selection can be tested in
 * isolation with plain DOM stubs - no store, no view layer, no event scaffolding. The view layer calls it on the change event, dispatches the returned action, and
 * lets the reactive re-projection drive the DOM through {@link applyRowState}.
 *
 * @module
 */

/**
 * Build the `<details>` shell for a category. Returns the disclosure element with its header (`<summary>`) and an empty `<div class="fo-category-rows">` rows
 * container. The rows container is intentionally empty; the view materializes its option rows lazily on first expand via {@link optionRow}.
 *
 * The category header carries a scope-suffix label - `(Global)` / `(Controller-specific)` / `(Device-specific)` - so the user always knows which scope they are
 * editing at. Each variant maps directly from the view's PRESENTED scope, which {@link projection} derives: the scope tag's own kind for an ordinary view, folded
 * to "controller" for a page whose selected device is the in-scope controller, where every edit is stored at the controller's serial. Taking the presented scope
 * rather than the raw tag is what makes the suffix name the scope an edit actually lands at, and it is a question the scope DU cannot answer on its own - the tag
 * says a device is selected without saying which device that is.
 *
 * @param {Object} args
 * @param {import("../featureOptions.js").FeatureCategoryEntry} args.category - The catalog entry for the category.
 * @param {"controller" | "device" | "global"} args.scopeKind - The view's presented scope, from the projection's `viewScope`.
 * @returns {HTMLDetailsElement} The category shell, ready for insertion into the config table.
 */
export const categoryShell = ({ category, scopeKind }) => {

  const arrow = createElement("span", { "aria-hidden": "true", classList: ["fo-category-arrow"] }, ["▶"]);
  const title = createElement("span", { classList: ["fo-category-title"] }, [category.description + scopeLabel(scopeKind)]);
  const summary = createElement("summary", { classList: ["fo-category-header"], title: "Expand or collapse this category." }, [ arrow, title ]);
  const rows = createElement("div", { classList: ["fo-category-rows"] });
  const details = createElement("details", { classList: ["fo-category"], "data-category": category.name });

  details.appendChild(summary);
  details.appendChild(rows);

  return details;
};

/**
 * Build one option row: its bare structure plus the initial state applied through {@link applyRowState}.
 *
 * Every row has one uniform shape - a checkbox followed by a `<div class="fo-option-content">` cell - regardless of option kind:
 *
 *   - **Boolean options**: the content cell holds only the `<label>`.
 *   - **Value-centric options**: the content cell stacks the `<label>` and an `<input type="text">` directly beneath it. The label always reads at full width and the
 *     field sits below at the width declared by the option's `inputSize` (5 ch when unspecified). The field never occupies a shared grid column, so its width cannot
 *     crush its own label or widen sibling rows. `inputSize` controls only the field's declared width.
 *   - **Secret value options**: the same stack, with the masked field and its reveal toggle sharing a horizontal wrapper so the control sits beside the field rather
 *     than beneath it. An option that declares no secret gets neither the wrapper nor the toggle, so the unflagged row's shape is exactly the one described above.
 *
 * The row structure is uniform regardless of option kind: one row, one stacked content cell, so a long descriptive label and a compact value render through exactly
 * the same path and differ only in the field's declared width.
 *
 * The element factories ({@link createCheckbox}, {@link createLabel}, {@link createValueInput}) build only the bare, state-independent shape. Every state-dependent
 * attribute - the checkbox tri-state, the value-input's value / disabled state, the label color, row visibility, the dependency badge - is set by {@link applyRowState}
 * once the structure exists. Sharing that single writer between construction here and the per-mutation update walk in the view is what keeps a freshly-built row and a
 * re-derived row identical.
 *
 * @param {Object} args
 * @param {boolean} [args.armed=false] - Whether this row is the store's armed value row (checked with a live input, awaiting its first value).
 * @param {string | null} args.deviceId - The currently-selected device's serial, or null for the global view.
 * @param {import("./selectors.mjs").ProjectionEntry} args.entry - The projection entry for this option.
 * @param {"controller" | "device" | "global"} args.scopeKind - The view's presented scope, from the projection's `viewScope`.
 * @returns {HTMLDivElement} The constructed row element.
 */
export const optionRow = ({ armed = false, deviceId, entry, scopeKind }) => {

  const { expandedName, isGrouped, option } = entry;
  const valueCentric = option.defaultValue !== undefined;
  const classes = [ "fo-option-row", ...(isGrouped ? ["grouped-option"] : []) ];

  const row = createElement("div", { classList: classes, id: "row-" + expandedName });

  // The content cell stacks the label and, for a value-centric option, its value-input directly beneath it. The label always reads at full width and the field sits
  // below at the declared inputSize width, so one layout serves both the compact and the descriptive case and no value-input ever occupies a shared right-hand column.
  const content = [createLabel({ entry, expandedName })];

  if(valueCentric) {

    content.push(option.secret ? createSecretField({ option }) : createValueInput({ option }));
  }

  row.appendChild(createCheckbox({ deviceId, expandedName, option }));
  row.appendChild(createElement("div", { classList: ["fo-option-content"] }, content));

  // The structure is in place; apply every state-dependent attribute from the projection entry. This is the same writer the view's per-mutation walk uses, so a
  // freshly-materialized row arrives correct from its first render without a separate "set the initial state here" path that could drift from the update path.
  applyRowState({ armed, entry, row, scopeKind });

  return row;
};

/**
 * Apply every state-dependent attribute of an option row from its projection entry. The single source of truth for "what does this row look like given the model" -
 * called once at construction (from {@link optionRow}) and again on every projection-affecting dispatch (from the view's update walk), so the row DOM is a pure
 * function of the projection at all times.
 *
 * What it derives:
 *
 *   - **Visibility** (`fo-hidden`) and the **dependency badge** (dimmed opacity + disabled checkbox) - a grouped option whose parent is currently disabled is shown
 *     dimmed and non-interactive when a filter or search keeps it visible; every other row carries no dim treatment.
 *   - **Checkbox tri-state** - inheriting from a higher scope reads as indeterminate + readOnly (the "borrowing from above" state the click machine cycles out of);
 *     otherwise the checkbox reflects the resolved enabled state directly.
 *   - **Label color** - the "where did this value come from / has it been modified" cue. Re-applying it here on every projection change is what makes a toggle that
 *     modifies (or reverts) an option re-color its label in place, rather than freezing the color at construction time.
 *   - **Value-input state** (value-centric options only) - the input is live exactly while the option can take a value at this scope: the row is enabled, or it is
 *     ARMED (the checkbox gesture opened the input and the first committed value is what will actually enable it - a scoped value entry always carries a value, so
 *     the checked-but-empty state persists nothing and lives only in the store's armedOption). Every other row locks its input, so a disabled or unset option can
 *     never take typing, and inheriting or parent-disabled rows lock regardless. The value text is re-derived from the projection EXCEPT while the user is
 *     actively editing it: uncommitted text exists only while the input holds focus (the `change` event commits on blur / Enter), so guarding on
 *     `document.activeElement` is exactly the condition under which a re-derive would clobber an in-progress edit. A secret option's reveal toggle locks and
 *     unlocks with the field it belongs to, and a row that locks returns to masked, so a row the user cannot type into is also a row they cannot read the value
 *     out of. A row that is still live keeps whatever reveal the user chose.
 *
 * @param {Object} args
 * @param {boolean} [args.armed=false] - Whether this row is the store's armed value row. An armed row renders checked with a live input while persisting nothing.
 * @param {import("./selectors.mjs").ProjectionEntry} args.entry - The projection entry for this option.
 * @param {HTMLDivElement} args.row - The option row element to update in place.
 * @param {"controller" | "device" | "global"} args.scopeKind - The view's presented scope, from the projection's `viewScope`.
 */
export const applyRowState = ({ armed = false, entry, row, scopeKind }) => {

  const inheriting = isInheritingView(scopeKind, entry.scope);

  row.classList.toggle("fo-hidden", !entry.visible);
  row.style.opacity = entry.requiresParentBadge ? "var(--fo-opacity-disabled)" : "";

  const checkbox = row.querySelector(".fo-option-checkbox");

  if(checkbox) {

    // The inherit axis (indeterminate + readOnly) and the dependency-badge axis (disabled) are independent; a row can be both inheriting and parent-disabled. An
    // armed row reads checked even though nothing is persisted yet - the checked state is the arming gesture's own affordance.
    checkbox.checked = entry.enabled || armed;
    checkbox.indeterminate = inheriting;
    checkbox.readOnly = inheriting;
    checkbox.disabled = entry.requiresParentBadge;
  }

  const label = row.querySelector(".fo-option-label");

  if(label) {

    applyLabelColor({ entry, inheriting, label });
  }

  const input = row.querySelector(".fo-option-value");

  if(input) {

    // The input is live exactly while the option can take a value at this scope: enabled, or armed and awaiting its first value. A disabled or unset row locks
    // its input - the checkbox is the affordance that arms it - and inheriting or parent-disabled rows lock regardless.
    const locked = inheriting || entry.requiresParentBadge || (!entry.enabled && !armed);

    input.readOnly = locked;
    input.disabled = locked;

    if(locked) {

      input.setAttribute("aria-disabled", "true");
    } else {

      input.removeAttribute("aria-disabled");
    }

    // A secret row's reveal answers to the same lock as its field: the toggle disables, and the field returns to masked. Both halves are needed for the rule to
    // hold - a field revealed while the row was live would otherwise sit there in clear text with the only control that could re-mask it disabled. A row still
    // live keeps whatever reveal the user chose, which is why the re-mask is bound to the locked state rather than run on every derive. Only a secret option
    // carries a toggle, so a plain value row finds nothing here.
    const secretToggle = row.querySelector(".fo-secret-toggle");

    if(secretToggle) {

      secretToggle.disabled = locked;

      if(locked) {

        applySecretMasking({ input, revealed: false, toggle: secretToggle });
      }
    }

    // Never overwrite the value the user is currently editing. Outside an active edit the projection's resolved value is authoritative - except on an armed row,
    // which presents an EMPTY field: arming asks the user for the option's first value, and the default display belongs to rows describing what resolution
    // already yields, not to a prompt awaiting entry. The empty field is also what lets the abandonment path read "still no value" honestly.
    if(document.activeElement !== input) {

      input.value = armed ? "" : (entry.value ?? defaultDisplay(entry.option));
    }
  }
};

/**
 * Flip a secret option's value input between masked and revealed, and re-label its toggle to match.
 *
 * Everything here is local to the page. Whether a secret is on screen right now says nothing about the configuration, so the flip computes no action, dispatches
 * nothing, and leaves the committed value alone; the field carries the same text before and after. On a live row the reveal survives every re-derivation, since
 * {@link applyRowState} writes the field's masking only when the row is locked - at which point the value goes back behind the mask and the toggle goes disabled
 * together. A fresh render starts masked again, since the element the builder hands back is a masked one.
 *
 * The state is read off the input's current masking rather than a remembered flag, and the type, the label, and the pressed state are written by the one
 * {@link applySecretMasking} writer this shares with the lock path, so the toggle's accessible name always describes what the next click does and cannot drift
 * from what the field is showing.
 *
 * A toggle whose row carries no value field is a quiet no-op. The view reaches this function by matching a class on whatever the user clicked, so the element it
 * hands over comes from markup rather than from a call site that can be checked, and the webUI's posture toward markup it did not build is to do nothing rather
 * than to throw inside a delegated handler.
 *
 * @param {HTMLButtonElement} toggle - The reveal toggle the user activated.
 */
export const toggleSecretReveal = (toggle) => {

  const input = toggle.closest(".fo-option-row")?.querySelector(".fo-option-value");

  if(!input) {

    return;
  }

  applySecretMasking({ input, revealed: input.type === "password", toggle });
};

/**
 * The tri-state click-time state machine. Given the current DOM state of a clicked checkbox (post-browser-toggle) plus the projection entry, configuration index, and
 * view context, compute the action to dispatch.
 *
 * The transitions, distinguished by the checkbox's pre-call state and the row's armed state:
 *
 *   - **armed, just unchecked** -> the user stood the armed row down before committing a value. Action: disarm - nothing was ever persisted, so there is nothing
 *     to clear or disable, and a write-shaped action would disturb state the arming gesture never touched.
 *   - **readOnly (was indeterminate)** -> the user clicked through to an explicit state at this scope. Action: set explicitly, or clear when the write rule says the
 *     entry-less resolution already matches the user's intent.
 *   - **just unchecked (was checked)** -> if an upstream entry exists, clear so resolution falls back to inheritance (the row returns to indeterminate); otherwise the
 *     explicit disable stays, recorded or normalized to a clear per the write rule.
 *   - **just checked (was unchecked)** -> set explicitly (or clear when the post-state matches default with no upstream). A value-centric row whose input carries no
 *     content ARMS instead: a scoped value entry always carries a value, so there is nothing to persist yet, and arming is what unlocks the input for the value
 *     that will.
 *
 * Write rule (parallels {@link FeatureOptions} semantics): a clearOption is correct when the resulting resolution equals the user's intent at this scope - that is,
 * when the catalog default matches AND no upstream entry exists. In that case the entry-less lookup naturally produces the right value. A setOption is needed when
 * any of those conditions break (default differs, value differs, upstream needs overriding).
 *
 * The function neither mutates nor returns DOM state: it returns only the action. The caller dispatches it, and the reactive re-projection drives the row's DOM
 * through {@link applyRowState} against the post-dispatch projection - the resolved tri-state the projection produces is, by construction, exactly the state this
 * transition intends, so there is no second DOM-writing path to keep in sync.
 *
 * @param {Object} args
 * @param {boolean} [args.armed=false] - Whether this row is the store's armed value row at gesture time.
 * @param {import("./state.mjs").Catalog} args.catalog - The catalog index (for value-centric detection and upstream lookup).
 * @param {HTMLInputElement} args.checkbox - The clicked checkbox, with its post-browser-toggle state.
 * @param {import("../featureOptions.js").ConfigIndex} args.configIndex - The current config lookup index.
 * @param {string | null} args.controllerId - The in-scope controller's scoping identity (the serial its entries are keyed by, from
 *        {@link scopingControllerId}), or null when no controller is in context.
 * @param {string | null} args.deviceId - The current view's device serial, or null for global view.
 * @param {import("./selectors.mjs").ProjectionEntry} args.entry - The projection entry for the option.
 * @param {HTMLInputElement | null} args.inputValue - The value-input element, when the option is value-centric; null otherwise.
 * @returns {{ action: Object }} The action to dispatch.
 */
export const triStateTransition = ({ armed = false, catalog, checkbox, configIndex, controllerId, deviceId, entry, inputValue }) => {

  const { expandedName, option } = entry;
  const upstream = hasUpstreamOption({ catalog, configIndex, controllerId, deviceId, expandedName });

  // Transition 0: an armed row just unchecked. Nothing was ever persisted, so the row simply stands down - a write-shaped action here would disable or clear
  // state the arming gesture never touched.
  if(armed && !checkbox.checked) {

    return { action: { type: "option:disarmed" } };
  }

  // Transition 1: was indeterminate (readOnly). The user clicked through to an explicit state at this scope.
  if(checkbox.readOnly) {

    return { action: writeAction({ deviceId, enabled: false, expandedName, inputValue, option, upstream, valueCentric: isValueOption(catalog, expandedName) }) };
  }

  // Transition 2: just transitioned to unchecked. With an upstream entry the clearOption returns the row to inheritance; without one the explicit disable stays
  // (recorded or normalized to a clear per the write rule).
  if(!checkbox.checked) {

    if(upstream) {

      return { action: { args: { id: deviceId ?? undefined, option: expandedName }, type: "option:cleared" } };
    }

    return { action: writeAction({ deviceId, enabled: false, expandedName, inputValue, option, upstream, valueCentric: isValueOption(catalog, expandedName) }) };
  }

  // Transition 3: just transitioned to checked. A SCOPED value-centric row with no value content arms rather than writes - a scoped value entry always carries a
  // value, so there is nothing to persist until one is typed, and arming is what unlocks the input to take it. The global view is deliberately outside this arm:
  // a bare valueless enable is a legal global entry, so the write below persists it and the enabled row's input unlocks through the ordinary lock rule.
  if((deviceId !== null) && isValueOption(catalog, expandedName) && !hasValueContent(inputValue?.value ?? "")) {

    return { action: { option: expandedName, type: "option:armed" } };
  }

  // Explicit enable at this scope.
  return { action: writeAction({ deviceId, enabled: true, expandedName, inputValue, option, upstream, valueCentric: isValueOption(catalog, expandedName) }) };
};

/**
 * The value-input commit state machine, the input-side counterpart of {@link triStateTransition} for value-centric rows. Given the committed input plus the
 * projection entry, configuration index, and view context, compute the action to dispatch - `null` when the commit has nothing to say.
 *
 * A commit carrying content (per hasValueContent, the same predicate the entry writer applies) sets the value at this scope, whatever the row's current state -
 * typing a value is the gesture that enables a value option here, so it works from unset and explicitly disabled rows alike. The {@link writeAction} write rule
 * still decides between an explicit entry and a clear that reaches the same resolution.
 *
 * A commit without content clears the entry of a row that is explicitly enabled at this scope, and resolution falls back to whatever the hierarchy answers -
 * an upstream entry where one exists, the catalog default otherwise. Clearing rather than composing a valueless enable is what makes emptying a pre-filled
 * field restore the default: a bare enable carries no value at all, so on a default-on value option it would override the declared default with nothing and
 * the user who cleared the field to get the default back would silently lose it. On any other row - unset, or explicitly disabled - there is no value to
 * remove and an enable-shaped dispatch would disturb state the gesture never addressed, so the commit yields no action and the caller restores the row from
 * the projection instead.
 *
 * The function neither mutates nor returns DOM state, mirroring {@link triStateTransition}: the caller dispatches the action (when there is one) and the
 * reactive re-projection drives the row's DOM through {@link applyRowState}.
 *
 * @param {Object} args
 * @param {import("./state.mjs").Catalog} args.catalog - The catalog index (for the upstream probe).
 * @param {import("../featureOptions.js").ConfigIndex} args.configIndex - The current config lookup index.
 * @param {string | null} args.controllerId - The in-scope controller's scoping identity (the serial its entries are keyed by, from
 *        {@link scopingControllerId}), or null when no controller is in context.
 * @param {string | null} args.deviceId - The current view's device serial, or null for global view.
 * @param {import("./selectors.mjs").ProjectionEntry} args.entry - The projection entry for the option.
 * @param {HTMLInputElement} args.inputValue - The value-input element carrying the committed text.
 * @returns {{ action: Object | null }} The action to dispatch, or null when the commit has nothing to write.
 */
export const valueCommitTransition = ({ catalog, configIndex, controllerId, deviceId, entry, inputValue }) => {

  const { expandedName, option } = entry;

  // A row is explicitly enabled at this scope when its own entry - not an inherited one - resolves it enabled: an entry exists at exactly this scope and the
  // resolved state is enabled, which a local disable would have overruled.
  const locallyEnabled = entry.enabled && optionExists({ configIndex, id: deviceId ?? undefined, option: expandedName });
  const emptyCommit = !hasValueContent(inputValue.value);

  if(emptyCommit && !locallyEnabled) {

    return { action: null };
  }

  // Emptying the field on a row enabled here drops its entry outright, handing resolution back to the hierarchy. The alternative - composing an enable with no
  // value behind it - would answer the option with nothing at all, which is the opposite of what clearing a pre-filled field asks for.
  if(emptyCommit) {

    return { action: { args: { id: deviceId ?? undefined, option: expandedName }, type: "option:cleared" } };
  }

  const upstream = hasUpstreamOption({ catalog, configIndex, controllerId, deviceId, expandedName });

  return { action: writeAction({ deviceId, enabled: true, expandedName, inputValue, option, upstream, valueCentric: true }) };
};

// Map a view scope kind to the suffix label rendered on category headers. Switch on the tag; every scope kind maps to its own label.
const scopeLabel = (scopeKind) => {

  switch(scopeKind) {

    case "global":

      return " (Global)";

    case "controller":

      return " (Controller-specific)";

    case "device":

      return " (Device-specific)";

    default:

      return "";
  }
};

// Decide whether the entry is "inherited from above" relative to the current view. The view is at viewKind; the entry resolved at resolvedScope. An entry is
// inherited when the resolved scope is strictly higher than the view scope. The switch covers the three current scope kinds; an unrecognized kind silently resolves to
// "not inheriting" rather than throwing.
const isInheritingView = (viewKind, resolvedScope) => {

  switch(viewKind) {

    case "global":

      // The view IS the highest scope - nothing is inherited from above.
      return false;

    case "controller":

      // From a controller view, only global is higher.
      return resolvedScope === "global";

    case "device":

      // From a device view, both global and controller are higher.
      return (resolvedScope === "global") || (resolvedScope === "controller");

    default:

      return false;
  }
};

// Build the checkbox element. Pure: returns a fresh element carrying only its bare, state-independent shape. The tri-state is applied by {@link applyRowState}.
const createCheckbox = ({ deviceId, expandedName, option }) => {

  const checkbox = createElement("input", {

    classList: ["fo-option-checkbox"],
    "data-device-serial": deviceId ?? "",
    id: expandedName,
    name: expandedName,
    type: "checkbox",
    value: expandedName + (deviceId ? ("." + deviceId) : "")
  });

  // Record the option's default-on/off as the checkbox's default state, kept separate from the live `.checked` tri-state that applyRowState owns. Nothing reads this
  // default today - there is no form reset, clone, or `:default` rule - but it keeps the element honest for any future consumer that relies on default-state semantics.
  checkbox.defaultChecked = option.default;

  return checkbox;
};

// Build the description label for an option. The `for` attribute connects it to the checkbox so native label-for click semantics work. The color class is applied
// separately by {@link applyLabelColor} (via {@link applyRowState}) so the label's structure stays state-independent.
const createLabel = ({ entry, expandedName }) => createElement("label", {

  classList: [ "fo-option-label", "user-select-none", "my-0", "py-0", "cursor-pointer" ],
  for: expandedName
}, [entry.description]);

// Apply the label's scope-color class, replacing any color previously applied. The color classes are mutually exclusive, so we strip every one of them before adding
// the current one - this makes the function safe to re-run on every projection change, which is what lets a toggle re-color a modified option's label
// in place. The construction path and the per-mutation update path share this one writer, so the initial color and every subsequent color come from the same map.
const applyLabelColor = ({ entry, inheriting, label }) => {

  label.classList.remove("text-body", "text-info", "text-success", "text-warning");
  label.classList.add(scopeColorClass({ entry, inheriting }));
};

// Map the row's display state to its Bootstrap utility class. Two cases by inheritance:
//
//   - **Inheriting from a higher scope**: the row is showing a value sourced from an ancestor scope. Color identifies the source - text-success for controller,
//     text-warning for global (warning because the global entry is the most distant source, the row is "borrowing" from far away).
//   - **Explicit at this scope or below** (not inheriting): the entry IS set at the current view's scope (or unset entirely). When the explicit state differs
//     from the catalog default, mark it text-info as a "this row has been modified" cue. Default-matching unset rows render text-body.
//
// The webUI's sole scope-to-class mapping. It consumes the `inheriting` boolean that {@link applyRowState} derives via {@link isInheritingView} from the view's
// scopeKind and the projection's `entry.scope`, rather than re-deriving that boolean itself; the switch below still reads `entry.scope` directly to pick the color.
const scopeColorClass = ({ entry, inheriting }) => {

  if(inheriting) {

    switch(entry.scope) {

      case "controller":

        return "text-success";

      case "global":

        return "text-warning";

      default:

        return "text-body";
    }
  }

  // Explicit at this scope or below. The modification highlight is boolean-deviation-only by design: a row lights up text-info only when its
  // enabled-state differs from the catalog default. A value-centric option whose value was changed but whose enabled-state still matches the default is intentionally
  // NOT highlighted - the cue tracks the boolean axis, not the value axis. A default-matching row renders plain body color.
  if(entry.isModified && (entry.enabled !== entry.option.default)) {

    return "text-info";
  }

  return "text-body";
};

// Build the value input for a value-centric option. Pure: returns a fresh element carrying only its bare, state-independent shape - the class set, the input type,
// and the width derived from the option's `inputSize` declaration (or 5 ch when unspecified), capped at the content cell's width so a wide field never overflows the
// row on a narrow panel. The value, readOnly, and disabled state are applied by {@link applyRowState}.
//
// A secret option masks its field, and a masked field asks the browser's credential manager to stay out of it: `new-password` is the autocomplete token that stops
// a manager both from offering a saved credential and from prompting to save what is typed, neither of which belongs in a settings frame editing a plugin's
// configuration. An unmasked field declares no autocomplete at all, so the secret declaration is the only thing that changes the element the builder returns.
const createValueInput = ({ option }) => createElement("input", {

  ...(option.secret ? { autocomplete: "new-password" } : {}),
  classList: [ "form-control", "shadow-none", "fo-option-value" ],
  style: {

    boxSizing: "content-box",
    fontFamily: "var(--fo-font-monospace)",
    maxWidth: "100%",
    width: (option.inputSize ?? 5) + "ch"
  },
  type: option.secret ? "password" : "text"
});

// The reveal toggle's two accessible names. Each names what the next click does rather than what the field is currently doing, which is what a control announced
// as a button wants to say.
const SECRET_HIDE_LABEL = "Hide the value.";
const SECRET_SHOW_LABEL = "Show the value.";

// The single writer for a secret field's masked presentation. The field's type and the toggle's labelling describe one state between them, so they are always
// written together: no path can move one and leave the other saying something else. Both callers pass the state they want rather than a direction, so the writer
// stays a plain projection of "is this value on screen" onto the DOM that says so.
const applySecretMasking = ({ input, revealed, toggle }) => {

  input.type = revealed ? "text" : "password";
  toggle.setAttribute("aria-label", revealed ? SECRET_HIDE_LABEL : SECRET_SHOW_LABEL);
  toggle.setAttribute("aria-pressed", revealed ? "true" : "false");
};

// The eye outline the reveal toggle wears: two symmetric curves meeting at the corners, with the pupil drawn separately as a circle.
const EYE_OUTLINE_PATH = "M1 8c2-3.2 4.3-4.8 7-4.8s5 1.6 7 4.8c-2 3.2-4.3 4.8-7 4.8S3 11.2 1 8Z";

// Build a secret option's field: the masked input and its reveal toggle side by side. The wrapper is what puts them side by side at all - the content cell stacks
// its children vertically, so without it the toggle would land on its own line beneath the field. Only a secret option is built this way; every other value option
// pushes its bare input straight into the cell, so an option that declares no secret carries no wrapper at all.
const createSecretField = ({ option }) => createElement("div", { classList: ["fo-secret-field"] }, [ createValueInput({ option }), createSecretToggle() ]);

// Build the reveal toggle. It starts masked, matching the field it accompanies, and carries its state on `aria-pressed` so assistive tech reads it as the two-state
// control it is. Its appearance - the surrendered button chrome and the inherited text color the glyph draws against - belongs to the theme stylesheet's
// `.fo-secret-toggle` rule, so the builder declares only what the control IS.
const createSecretToggle = () => createElement("button", {

  "aria-label": SECRET_SHOW_LABEL,
  "aria-pressed": "false",
  classList: ["fo-secret-toggle"],
  type: "button"
}, [createEyeGlyph()]);

// Build the toggle's eye glyph. Every mark draws in currentColor and the graphic is sized in em, so the glyph takes both the color and the scale of the text around
// it - the same way the sparkline strip wears whatever color its surroundings wear. It is hidden from assistive tech because the button's own label already names
// the action, and a decorative graphic announced beside that label would only repeat it.
const createEyeGlyph = () => {

  const glyph = createSvgElement({

    attributes: {

      "aria-hidden": "true",
      "fill": "none",
      "height": "1em",
      "stroke": "currentColor",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "stroke-width": "1.25",
      "viewBox": "0 0 16 16",
      "width": "1em"
    },
    tag: "svg"
  });

  glyph.append(createSvgElement({ attributes: { "d": EYE_OUTLINE_PATH }, tag: "path" }),
    createSvgElement({ attributes: { "cx": "8", "cy": "8", "r": "2.1" }, tag: "circle" }));

  return glyph;
};

// Render the catalog's `defaultValue` as the displayable string used by both the input element and the deviation comparison. Empty string is the consistent
// representation across every consumer so the input reads empty when disabled and the deviation check treats an empty input as "matches default."
const defaultDisplay = (option) => option.defaultValue?.toString() ?? "";

// Whether the option is set at a strictly higher scope that the current view actually inherits from. Drives the "fall back to inheritance" branch of the tri-state
// machine: a checked checkbox that goes unchecked returns to indeterminate when upstream is set, otherwise stays explicitly unchecked.
//
// Each level counts only when the option's declared scopes admit it, because this is a prediction of what resolution will do once the local entry is gone and it has
// to agree with resolution exactly. Counting an entry the engine would skip would promise the user an inheritance that never arrives: the click would dispatch a
// clear, resolution would land on the catalog default instead of the entry the probe saw, and the checkbox would spring back against the click.
const hasUpstreamOption = ({ catalog, configIndex, controllerId, deviceId, expandedName }) => {

  // Global view (no device) is the top - nothing above it. A device view where the device IS the controller-as-device collapses to "controller view" which only
  // inherits from global; the controllerIsUpstream check below handles that case.
  if(!deviceId) {

    return false;
  }

  const declaredScopes = catalog.scopes[expandedName.toLowerCase()];
  const controllerIsUpstream = (controllerId !== null) && (deviceId !== controllerId) && (!declaredScopes || declaredScopes.includes("controller"));

  if(controllerIsUpstream && optionExists({ configIndex, id: controllerId, option: expandedName })) {

    return true;
  }

  return (!declaredScopes || declaredScopes.includes("global")) && optionExists({ configIndex, option: expandedName });
};

// Decide whether the post-transition state warrants writing a new entry, or whether clearing the option falls back to the default. We write when the user's intent
// differs from the catalog default on the boolean axis, when an enabled post-state carries a value differing from the default, or when there is an upstream entry
// that the local state needs to override. Otherwise clearing is equivalent and keeps the configuredOptions array minimal.
//
// The value axis counts only toward an enabled post-state, because a disabled entry never carries a value: the entry writer strips it, so text left sitting in the
// input has no bearing on what a disable would persist. This rule is a prediction of what the writer will actually store and it has to agree with the writer
// exactly...treating residual text as a deviation would compose an explicit disable that says nothing the catalog default does not already say.
const writeAction = ({ deviceId, enabled, expandedName, inputValue, option, upstream, valueCentric }) => {

  const inputValueText = inputValue?.value ?? "";
  const valueDeviates = enabled && (inputValue !== null) && (inputValueText !== defaultDisplay(option));
  const booleanDeviates = enabled !== option.default;
  const writeNeeded = booleanDeviates || valueDeviates || upstream;
  const id = deviceId ?? undefined;

  if(!writeNeeded) {

    return { args: { id, option: expandedName }, type: "option:cleared" };
  }

  const value = (valueCentric && enabled && (inputValueText.length > 0)) ? inputValueText : undefined;

  return { args: { enabled, id, option: expandedName, value }, type: "option:set" };
};
