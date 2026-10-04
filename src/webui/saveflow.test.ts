/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webui/saveflow.test.ts: Compile-time shape exercises for the save flow's generic contract - the card's own action carried onto the result and into the check's
 * context, the checked value inferred into the composer and onto the result, the commit result's exact members, and a commit typed against `object` or against a
 * plugin's own configuration accepted with no type arguments written. The flow's behaviour is specified by its suite beside the page, ui/webUi-saveFlow.test.mjs.
 */
import type { Assert, Equal } from "../testing/index.ts";
import type { CommitConfig, CommitConfigResult } from "./commit.ts";
import type { SaveAction, SaveFlow } from "./saveflow.ts";
import { createSaveFlow } from "./saveflow.ts";

// A plugin's own configuration, as a plugin names it for its composers.
interface PluginConfig {

  readonly controllers: readonly { readonly address: string }[];
}

// A card's own action, carrying a member the flow never reads beside the SaveAction members it does.
interface CardAction extends SaveAction {

  readonly takeover: { readonly release: () => void };
}

/* Compile-time shape exercises for the flow's generics. These never run - the function is never called, and its leading underscore marks it, with its bindings,
 * as a compile-time exercise the typecheck reads - so they add nothing to the runtime totals; TypeScript still type-checks the body during `npm run typecheck`, so
 * a contract regression fails the build here rather than silently at a consuming plugin. Every call is written with no type arguments, the form through which a
 * consumer and a JavaScript caller reach the flow, so each row reads what inference and the defaults hand them.
 */
const _saveFlowShapeExercises = (): void => {

  const raised: string[] = [];
  const record = (message: string): void => {

    raised.push(message);
  };

  const toast = { error: record, info: record, success: record, warning: record };
  const start = (): CardAction => ({ presented: (): boolean => true, signal: new AbortController().signal, takeover: { release: (): void => record("released") } });

  // A commit typed against `object`, the page's own commit as a card is handed it.
  const plainCommit: CommitConfig = async (compose): Promise<CommitConfigResult> => (compose({}) === null) ? { kind: "unchanged" } : { kind: "committed" };

  // A commit typed against the plugin's own configuration, the narrowed form a plugin's suite double or typed page wrapper takes.
  const pluginCommit: CommitConfig<PluginConfig> = async (compose): Promise<CommitConfigResult> => {

    return (compose({ controllers: [] }) === null) ? { kind: "unchanged" } : { kind: "committed" };
  };

  // A commit typed against `object` is accepted with no type arguments, and the flow it builds is the bare SaveFlow every default names.
  const _plainFlow = createSaveFlow({ commit: plainCommit, control: null, start: (): SaveAction => start(), toast });

  type _PlainFlowIsBare = Assert<Equal<typeof _plainFlow, SaveFlow>>;

  // A commit typed against the plugin's own configuration is accepted with no type arguments, and the flow carries that configuration and the card's action.
  const flow = createSaveFlow({ commit: pluginCommit, control: null, start, toast });

  type _PluginFlowIsExact = Assert<Equal<typeof flow, SaveFlow<PluginConfig, CardAction>>>;

  // The checked value is inferred from what the check answers, and reaches the composer's second parameter beside the plugin's own configuration.
  const _pressed = flow.save({

    check: async () => ({ kind: "passed", value: { address: "10.0.0.9" } }),
    compose: (platform, value) => {

      type _ComposedPlatformIsThePlugins = Assert<Equal<typeof platform, PluginConfig>>;
      type _ComposedValueIsTheChecked = Assert<Equal<typeof value, { address: string }>>;

      return { controllers: [ ...platform.controllers, value ] };
    }
  });

  // The result of a press that wrote carries the card's own action and the checked value.
  type _Committed = Extract<Awaited<typeof _pressed>, { kind: "committed" }>;
  type _ResultActionIsTheCards = Assert<Equal<_Committed["action"], CardAction>>;
  type _ResultValueIsTheChecked = Assert<Equal<_Committed["value"], { address: string }>>;

  // The check's context carries the card's own action too, so a check reads the card's members typed as the card declared them.
  const _declined = flow.save({

    check: (_context) => {

      type _ContextActionIsTheCards = Assert<Equal<typeof _context.action, CardAction>>;

      return { kind: "declined", reason: "The controller did not answer." };
    },
    compose: (): null => null
  });

  // The commit result is exactly the union written out here, each member that answers for a refusal carrying its error as unknown.
  type _CommitResultIsExact = Assert<Equal<CommitConfigResult, { readonly kind: "committed" } | { readonly error: unknown; readonly kind: "staged" } |
    { readonly error: unknown; readonly kind: "failed" } | { readonly kind: "unchanged" }>>;
};
