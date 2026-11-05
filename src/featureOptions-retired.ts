/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * featureOptions-retired.ts: Retired feature option families - the per-member options a plugin's retired grammar spelled a selection through, translated into the
 * value option that carries the selection in the current grammar.
 */

/**
 * Retired feature option families, declared as data and translated through the engine's own grammar.
 *
 * A plugin whose retired grammar spelled a selection member by member - one boolean option per detection type, per button, per logging category - and whose
 * current grammar carries it in one value option has configurations to translate. The retired names are gone from its catalog, and several of their shapes are
 * worse than stale: read through the current catalog, a retired per-member entry can decompose into a value of the very option that superseded it, and a retired
 * master scoped to an identifier can read as that option's global value. A plugin states each family once, as a {@link RetiredFamily}, and
 * {@link createRetiredOptions} answers each act it needs:
 *
 *   - {@link RetiredOptions.migrate} - the durable rewrite a settings page commits, composed through the controller topology the page knows, so a device's
 *     selection is composed through its true controller and a scope the page cannot place yet waits for a pass that can.
 *   - {@link RetiredOptions.translate} - the in-memory view a plugin's Node side builds its engine on at boot, with {@link RetiredTranslation.selection}, the
 *     runtime overlay that answers a family's exact historic selection for a reader holding its own device and controller.
 *
 * The whole layer runs on the engine's primitives. The factory declares the retired names as an ordinary all-boolean catalog, so {@link buildConfigIndex} reads a
 * configuration exactly as production does and {@link resolveScope} answers any retired member's old effective state at any device and controller - the precedence
 * the engine has always owned stays owned by the engine, pointed at a catalog that describes the past. Every entry the layer writes is composed by
 * {@link composeEntry}, the one writer of the grammar, and every entry it does not account for passes through byte-verbatim, because a configuration is the user's
 * own text.
 *
 * The module imports nothing but the feature-options core, so it is browser-safe: a settings page loads the compiled copy the build ships into `dist/ui/`, and a
 * plugin's Node side imports the same engine from the package root.
 *
 * @module
 */
import { ALL_CHOICES, buildCatalogIndex, buildConfigIndex, composeEntry, decodeEntryAddress, enumerateConfiguredEntries, formatValueList, resolveScope,
  selectValues } from "./featureOptions.ts";
import type { CatalogIndex, ConfigIndex, FeatureCategoryEntry, FeatureOptionEntry } from "./featureOptions.ts";

/**
 * One retired option, paired with the value its family's surviving option stores for it.
 *
 * @property default - The retired option's own catalog default, which is what its family's composition resolves against wherever a configuration says nothing.
 * @property option  - The retired option's expanded name, as the plugin's catalog once declared it.
 * @property value   - The value the surviving option stores when this member is selected.
 *
 * @category Feature Options
 */
export interface RetiredMember {

  readonly default: boolean;
  readonly option: string;
  readonly value: string;
}

/**
 * One retired grammar: the members a plugin's retired options spelled a selection through, and the value option that carries that selection in the current grammar.
 *
 * Whether the surviving option holds one value or a list is read from its own catalog entry rather than declared here: an option declaring
 * {@link FeatureOptionEntry.multiple} composes every enabled member, and any other composes to the first enabled member in `members` order, which is how a family
 * whose members were ranked - stream tiers best first - keeps the rule its retired options resolved through.
 *
 * @property keptName    - Optional. True when the surviving option kept the name a retired master carried, so the master's own entries spell the same as the
 *                         surviving option's. Such a family speaks only where its master resolves enabled and states its selection outright there, the empty
 *                         selection included; with no members it states {@link ALL_CHOICES}, which is what switching the master on meant. Every option the
 *                         plugin's catalog declares under the kept name is read as itself, never as the master scoped to an identifier spelling the rest.
 * @property members     - The retired options, in the order a composition lists them. Empty for a kept-name family whose master was its whole grammar.
 * @property option      - The surviving option's expanded name.
 * @property overlayOnly - Optional. True leaves the family's retired entries in the boot view exactly as written, with the overlay alone giving them their meaning,
 *                         for a family whose composition needs a domain a configuration string does not carry - a relay's outputs, say. The durable rewrite
 *                         composes it like any other family.
 *
 * @category Feature Options
 */
export interface RetiredFamily {

  readonly keptName?: boolean;
  readonly members: readonly RetiredMember[];
  readonly option: string;
  readonly overlayOnly?: boolean;
}

/**
 * One controller and the devices beneath it, as the topology a durable rewrite composes through.
 *
 * @property devices - The scope identifiers of the devices found on this controller.
 * @property id      - The controller's own scope identifier.
 *
 * @category Feature Options
 */
export interface RetiredController {

  readonly devices: readonly string[];
  readonly id: string;
}

/**
 * What a durable rewrite answers.
 *
 * @property configuredOptions - The configured options with every family this pass could compose exactly stated through its canonical entries in place of its
 *                               retired ones, the compositions following the surviving entries in order. The input reference itself when nothing was consumed or
 *                               composed.
 * @property remaining         - True when a family kept its retired entries because the topology this pass had could not place one of its scopes, which a caller
 *                               reads as "probe wider and come back". A converged configuration answers false.
 *
 * @category Feature Options
 */
export interface RetiredMigration {

  readonly configuredOptions: readonly string[];
  readonly remaining: boolean;
}

/**
 * Arguments for {@link RetiredTranslation.selection}: the reader's own position in the hierarchy, the option it reads, and the domain it reads against.
 *
 * @property controller - Optional. The reader's controller scope identifier.
 * @property device     - Optional. The reader's device scope identifier.
 * @property domain     - The values the option offers in this context, which the answer is expressed in.
 * @property option     - The surviving option being read, matched without regard to casing.
 *
 * @category Feature Options
 */
export interface RetiredSelectionArgs {

  controller?: string;
  device?: string;
  domain: readonly string[];
  option: string;
}

/**
 * The boot view of a configuration: the entries the engine is built on, the overlay a family still needs, and the entries the translation acted on.
 *
 * @property configuredOptions - The configured options with every retired shape the engine would misread composed into the current grammar, surviving entries in
 *                               order and the compositions after them. The input reference itself when nothing was consumed or composed.
 * @property translated        - The retired entries the translation consumed, superseded or left in place for the overlay, verbatim, for a plugin's startup
 *                               narration. Empty when the configuration is already canonical.
 *
 * @category Feature Options
 */
export interface RetiredTranslation {

  readonly configuredOptions: readonly string[];

  /**
   * Resolve a family's selection the way its retired options resolved it, for a reader that knows its own device and controller - or answer undefined when no
   * family still needs the overlay for this option, and the reader reads the engine as it always does.
   *
   * The boot view composes each scope without topology, because a configuration string cannot say which identifiers name controllers. The reader supplies the real
   * device and controller here, so the engine's own walk over the retired catalog answers exactly what the retired reads answered. An option whose family is
   * converged, superseded by the user's own entry, or never configured answers undefined after one map lookup, which is what keeps the read free once a
   * configuration has converged.
   *
   * @param args - The reader's position, the option, and the domain. See {@link RetiredSelectionArgs}.
   *
   * @returns The selected values in the domain's own spelling and order, or undefined when the overlay has nothing to say about this option.
   */
  selection(args: RetiredSelectionArgs): readonly string[] | undefined;

  readonly translated: readonly string[];
}

/**
 * The acts one set of retired families answers, built once over a plugin's catalog by {@link createRetiredOptions}.
 *
 * @category Feature Options
 */
export interface RetiredOptions {

  /**
   * Rewrite a configuration's retired entries into the current grammar, permanently, as far as the supplied topology makes exact.
   *
   * Each family is composed per scope it names. A scope's selection is compared against what it inherits - the global scope against the members' own defaults, a
   * named scope against the global composition, through its controller when the topology places it - and only a scope with something of its own to say is
   * written. Retirement is per family: one the topology cannot place keeps its entries exactly as written while its neighbors migrate.
   *
   * `controllers` means one thing omitted and another supplied. Omitted, the plugin is flat: there is no controller above a device, so every
   * family composes through its scope and the global level, which is exact. Supplied, even as an empty list, the plugin has a hierarchy the list describes, and a
   * family naming a scope the list cannot place keeps its entries whole and sets `remaining` - unless the user's own entry already supersedes it, in which case its
   * retired entries simply leave. A controller answers for itself and a device for the controller it was found on, matched without regard to case.
   *
   * @param args
   * @param args.configuredOptions - The configured feature options to rewrite.
   * @param args.controllers       - Optional. The controllers that answered this pass, each with the devices beneath it. Omit it for a plugin with no controller
   *                                 level; supply it, empty included, for one whose devices sit beneath controllers.
   *
   * @returns The rewritten options and whether any family still waits for a wider topology.
   */
  migrate(args: { configuredOptions: readonly string[]; controllers?: readonly RetiredController[] }): RetiredMigration;

  /**
   * Read a configuration written in any era of the plugin's grammar and answer what the engine should be built on, with the overlay for whatever a composition
   * without topology can only approximate.
   *
   * Every family composes without topology, a scope through itself and the global level, and the family joins the overlay so a reader holding its own device and
   * controller gets the exact historic answer. A family declaring `overlayOnly` is left as written and answered by the overlay alone.
   *
   * @param configuredOptions - The configured feature options, exactly as they appear in the configuration.
   *
   * @returns The boot view, the overlay, and the entries the translation acted on.
   */
  translate(configuredOptions: readonly string[]): RetiredTranslation;
}

// What a retired option is to its family: one member of the selection, or the master whose name the surviving option kept.
interface RetiredRole {

  readonly family: RetiredFamily;
  readonly master: boolean;
}

// One configured entry a family carries, decoded once so every pass over that family reads the same decoding. The scope keeps the casing the entry carried.
interface RetiredEntry {

  readonly enabled: boolean;
  readonly index: number;
  readonly master: boolean;
  readonly raw: string;
  readonly scope: string;
}

// What one family has to say about a configuration: the entries that leave it, the scopes it speaks at - each folded identifier beside the spelling it first
// appeared in - and whether the user's own entry for the surviving option supersedes it.
interface FamilyReading {

  readonly family: RetiredFamily;
  readonly leaving: readonly RetiredEntry[];
  readonly scopes: ReadonlyMap<string, string>;
  readonly superseded: boolean;
}

// The answer of a configuration naming nothing retired, shared because it carries nothing particular to any call, and frozen so no caller can write into it.
const NOTHING_TRANSLATED: readonly string[] = Object.freeze([]);

/* The retired catalog: the retired grammar's view of every family, declared as ordinary boolean options under folded names, so the engine's own readers answer what a
 * configuration meant when it was written.
 *
 * Every member is declared at its own default, and a kept-name master at the default its surviving option declares, since that option is the master's own
 * continuation. Every option the served catalog declares under a kept name is declared too, so the engine's arbitration settles an address like
 * `Motion.OccupancySensor.Duration` as that option rather than as the master scoped to an identifier called "Duration". A name is declared once, by its first
 * declaration, which is a family's own member or master ahead of any such option. A boolean declaration never reads a trailing segment as a value, so reading this
 * catalog cannot provoke the value misreading the translation exists to remove.
 */
function retiredCatalog({ families, served }: { families: readonly RetiredFamily[]; served: CatalogIndex }): CatalogIndex {

  const declared = new Map<string, boolean>();
  const declare = (name: string, enabled: boolean): void => {

    if(!declared.has(name)) {

      declared.set(name, enabled);
    }
  };

  for(const family of families) {

    for(const member of family.members) {

      declare(member.option.toLowerCase(), member.default);
    }

    if(family.keptName) {

      declare(family.option.toLowerCase(), served.defaults[family.option.toLowerCase()] ?? false);
    }
  }

  for(const family of families) {

    if(!family.keptName) {

      continue;
    }

    const prefix = family.option.toLowerCase() + ".";

    for(const name of Object.keys(served.defaults)) {

      if(name.startsWith(prefix)) {

        declare(name, false);
      }
    }
  }

  // Each folded name is split at its first dot into a category and an option, which expands back to the same name; a name with no dot is its category's own
  // option. The grouping is a map because the category names are the plugin's own, which a plain object would let collide with the names every object inherits.
  const options = new Map<string, FeatureOptionEntry[]>();

  for(const [ name, enabled ] of declared) {

    const separator = name.indexOf(".");
    const category = (separator === -1) ? name : name.slice(0, separator);
    const entries = options.get(category) ?? [];

    entries.push({ default: enabled, description: "", name: (separator === -1) ? "" : name.slice(separator + 1) });
    options.set(category, entries);
  }

  return buildCatalogIndex([...options.keys()].map((name) => ({ description: "", name })), Object.fromEntries(options));
}

/**
 * Build the translation of a plugin's retired feature option families over its catalog.
 *
 * The factory reads the catalog once: it builds the served catalog's index, the retired catalog the families describe, and the configured-options index of an
 * empty configuration that a family's untouched defaults resolve through. Each act then runs one survey of the configuration it is handed. An entry the retired
 * catalog reads as a family's member, or as a kept-name master, belongs to that family; a family speaks at every scope a member entry names, and at a scope a
 * bare scoped enable of its master names. A master at the global scope spells the same thing in the retired grammar and the current one, so it stands as written
 * unless a member entry brings the global scope in.
 *
 * The user's own entry for a family's surviving option outranks the family. For a kept-name family that is a value behind the payload delimiter at any scope,
 * since a bare master spells the same in the retired grammar and the current one; for any other family it is any entry for the option at any scope, bare or
 * valued, since the option did not exist in the retired grammar. A superseded family's retired entries leave, nothing is composed for it, and the overlay answers
 * nothing for it.
 *
 * Families walk in the order they are declared and a family's scopes in the order they first appear, each identifier once whatever its casing and in the spelling
 * it first appeared in. Surviving entries stay byte-verbatim and in order, and the composed entries follow them. Each act answers the input array itself when it
 * consumed and composed nothing, so a caller tells a no-op by reference.
 *
 * @param args
 * @param args.categories - The plugin's feature option categories, exactly as its catalog declares them.
 * @param args.families   - The retired families, in the order their compositions are emitted.
 * @param args.options    - The plugin's feature options, exactly as its catalog declares them.
 *
 * @returns The durable rewrite and the boot translation over those families.
 *
 * @throws `Error` naming the option when a family's surviving option is one the catalog does not declare, or a member's retired option is one it still declares.
 *
 * @example
 *
 * ```ts
 * // A logging list whose retired grammar was one switch per category, each of which defaulted on.
 * const retired = createRetiredOptions({ categories: featureOptionCategories, families: [{ members: [
 *
 *   { default: true, option: "Log.Doorbell", value: "Doorbell" },
 *   { default: true, option: "Log.Lock", value: "Lock" }
 * ], option: "Log.Events" }], options: featureOptions });
 *
 * // At boot, the engine is built on the boot view and a list read consults the overlay first.
 * const translation = retired.translate(config.options);
 * const engine = new FeatureOptions(featureOptionCategories, featureOptions, [...translation.configuredOptions]);
 * const events = translation.selection({ device: hub.mac, domain, option: "Log.Events" }) ??
 *   engine.valueList({ defaultWhenUnset: true, device: hub.mac, domain, option: "Log.Events" });
 * ```
 *
 * @category Feature Options
 */
export function createRetiredOptions({ categories, families, options }: {

  categories: readonly FeatureCategoryEntry[];
  families: readonly RetiredFamily[];
  options: Readonly<Record<string, readonly FeatureOptionEntry[]>>;
}): RetiredOptions {

  const served = buildCatalogIndex(categories, options);

  /* A family is the plugin's own declaration, so a family that cannot mean what it says is a declaration bug, refused here at construction as the catalog builder
   * refuses its own: a surviving option the catalog does not declare has nothing to carry the selection, and a member the catalog still declares is a live option
   * whose entries the translation would consume.
   */
  for(const family of families) {

    if(!(family.option.toLowerCase() in served.optionsByName)) {

      throw new Error("FeatureOptions: the retired family carried by \"" + family.option + "\" names an option the catalog does not declare.");
    }

    for(const member of family.members) {

      if(member.option.toLowerCase() in served.optionsByName) {

        throw new Error("FeatureOptions: the retired member \"" + member.option + "\" is an option the catalog still declares.");
      }
    }
  }

  const retired = retiredCatalog({ families, served });
  const defaultIndex = buildConfigIndex(retired, []);
  const roles = new Map<string, RetiredRole>();

  for(const family of families) {

    for(const member of family.members) {

      roles.set(member.option.toLowerCase(), { family, master: false });
    }

    if(family.keptName) {

      roles.set(family.option.toLowerCase(), { family, master: true });
    }
  }

  // A family's selection at a scope, asked of the engine member by member. The caller decides what the scope is: the overlay passes a reader's real device and
  // controller, a durable rewrite passes a scope identifier at the device level with the controller the topology places it under, and the boot view passes the
  // identifier alone. A surviving option that stores one value stops at the first enabled member.
  const compose = ({ configIndex, controller, device, family }: {

    configIndex: ConfigIndex;
    controller?: string;
    device?: string;
    family: RetiredFamily;
  }): string[] => {

    const single = served.optionsByName[family.option.toLowerCase()]?.multiple !== true;
    const selected: string[] = [];

    for(const member of family.members) {

      if(!resolveScope({ catalog: retired, configIndex, controller, device, option: member.option }).enabled) {

        continue;
      }

      selected.push(member.value);

      if(single) {

        break;
      }
    }

    return selected;
  };

  /* The canonical entry stating a family's selection at one scope, or undefined when the scope has nothing of its own to say.
   *
   * A kept-name family's entries carry an enablement as well as a selection, so a scope where the master resolves enabled states its selection outright, the empty
   * selection included, and a scope where it resolves disabled states nothing: the entry that disabled it is still there saying so. Any other family speaks where its
   * composition differs from what the scope would inherit without an entry, which keeps the rewrite minimal - a scope restating what it inherits states nothing,
   * and one turning off everything a broader scope turned on states the plain Disable. A selection of every member states the all-choices value where the surviving
   * option's default is that value, so the scope keeps tracking whatever domain a device reports.
   */
  const compositionAt = ({ configIndex, controller, family, scope }: {

    configIndex: ConfigIndex;
    controller?: string;
    family: RetiredFamily;
    scope: string;
  }): string | undefined => {

    const device = scope.length ? scope : undefined;
    const here = compose({ configIndex, controller, device, family });

    if(family.keptName) {

      if(!resolveScope({ catalog: retired, configIndex, controller, device, option: family.option }).enabled) {

        return undefined;
      }

      return composeEntry({ enabled: true, id: scope, option: family.option, value: family.members.length ? formatValueList(here) : ALL_CHOICES });
    }

    const inherited = device ? compose({ configIndex, controller, family }) : compose({ configIndex: defaultIndex, family });

    // Each composition lists members in the family's own order, so comparing them position by position is comparing the selections.
    if((here.length === inherited.length) && here.every((value, index) => value === inherited[index])) {

      return undefined;
    }

    if(!here.length) {

      return composeEntry({ enabled: false, id: scope, option: family.option });
    }

    const everyMember = (here.length === family.members.length) && (served.valueOptions[family.option.toLowerCase()] === ALL_CHOICES);

    return composeEntry({ enabled: true, id: scope, option: family.option, value: everyMember ? ALL_CHOICES : formatValueList(here) });
  };

  // Whether the user's own entry for a family's surviving option outranks the family. The entries read are the ones the survey assigned to no family, since a
  // retired dot form can decompose into a value of the surviving option and would otherwise read as the user's own.
  const supersedes = ({ family, unclaimed }: { family: RetiredFamily; unclaimed: readonly string[] }): boolean => {

    const candidates = family.keptName ? unclaimed.filter((entry) => entry.includes("=")) : unclaimed;

    for(const entry of enumerateConfiguredEntries({ catalog: served, configuredOptions: candidates, option: family.option })) {

      if(!family.keptName || (entry.value !== undefined)) {

        return true;
      }
    }

    return false;
  };

  /* What each family has to say about one configuration, in declared order, leaving out a family with nothing to say.
   *
   * A family's entries leave the engine's view wherever a replacement is composed for them: every member entry, and a master's enable at a scope the family speaks
   * at. A master's Disable never leaves, since nothing composed could say what it says, and neither does a global master no member entry brought the global scope in
   * beside.
   */
  const survey = (configuredOptions: readonly string[]): FamilyReading[] => {

    const found = new Map<RetiredFamily, RetiredEntry[]>();
    const unclaimed: string[] = [];

    for(const [ index, raw ] of configuredOptions.entries()) {

      const address = decodeEntryAddress(retired, raw);
      const role = address ? roles.get(address.option) : undefined;

      if(!address || !role) {

        unclaimed.push(raw);

        continue;
      }

      const entries = found.get(role.family) ?? [];

      entries.push({ enabled: address.enabled, index, master: role.master, raw, scope: address.id });
      found.set(role.family, entries);
    }

    const readings: FamilyReading[] = [];

    for(const family of families) {

      const entries = found.get(family) ?? [];
      const scopes = new Map<string, string>();

      for(const entry of entries) {

        if((!entry.master || (entry.enabled && entry.scope.length)) && !scopes.has(entry.scope.toLowerCase())) {

          scopes.set(entry.scope.toLowerCase(), entry.scope);
        }
      }

      if(!scopes.size) {

        continue;
      }

      readings.push({ family, leaving: entries.filter((entry) => !entry.master || (entry.enabled && scopes.has(entry.scope.toLowerCase()))), scopes,
        superseded: supersedes({ family, unclaimed }) });
    }

    return readings;
  };

  // The configuration with the consumed entries removed and the compositions appended, or the input array itself when there is neither.
  const rewrite = ({ configuredOptions, consumed, emissions }: {

    configuredOptions: readonly string[];
    consumed: ReadonlySet<number>;
    emissions: readonly string[];
  }): readonly string[] => {

    if(!consumed.size && !emissions.length) {

      return configuredOptions;
    }

    return configuredOptions.filter((_, index) => !consumed.has(index)).concat(emissions);
  };

  return {

    migrate: ({ configuredOptions, controllers }): RetiredMigration => {

      const readings = survey(configuredOptions);

      if(!readings.length) {

        return { configuredOptions, remaining: false };
      }

      const configIndex = buildConfigIndex(retired, configuredOptions);
      const consumed = new Set<number>();
      const emissions: string[] = [];

      // The controller each folded identifier resolves under: a controller answers for itself, and a device for the controller it was found on.
      const placed = new Map<string, string>();

      for(const controller of controllers ?? []) {

        placed.set(controller.id.toLowerCase(), controller.id);

        for(const device of controller.devices) {

          placed.set(device.toLowerCase(), controller.id);
        }
      }

      let remaining = false;

      for(const { family, leaving, scopes, superseded } of readings) {

        // A topology that cannot place every scope a family names would compose one of them against the wrong hierarchy, so the whole family waits rather than
        // half-migrating.
        if(!superseded && controllers && [...scopes.keys()].some((scope) => scope.length && !placed.has(scope))) {

          remaining = true;

          continue;
        }

        for(const entry of leaving) {

          consumed.add(entry.index);
        }

        if(superseded) {

          continue;
        }

        for(const [ key, scope ] of scopes) {

          const controller = placed.get(key);
          const emission = compositionAt({ configIndex, controller: (controller?.toLowerCase() === key) ? undefined : controller, family, scope });

          if(emission !== undefined) {

            emissions.push(emission);
          }
        }
      }

      return { configuredOptions: rewrite({ configuredOptions, consumed, emissions }), remaining };
    },

    translate: (configuredOptions): RetiredTranslation => {

      const readings = survey(configuredOptions);

      if(!readings.length) {

        return { configuredOptions, selection: (): undefined => undefined, translated: NOTHING_TRANSLATED };
      }

      // One index for the whole translation, which the overlay keeps reading for as long as the plugin holds it.
      const configIndex = buildConfigIndex(retired, configuredOptions);
      const consumed = new Set<number>();
      const emissions: string[] = [];
      const overlaid = new Map<string, RetiredFamily>();
      const translated: string[] = [];

      for(const { family, leaving, scopes, superseded } of readings) {

        for(const entry of leaving) {

          if(!family.overlayOnly) {

            consumed.add(entry.index);
          }

          translated.push(entry.raw);
        }

        if(superseded) {

          continue;
        }

        // A family with members carries a composition the boot view can only approximate without topology, so it joins the overlay. A family with none states the
        // whole of what its retired entry meant in its one composition, so the boot view is already exact for it.
        if(family.members.length) {

          overlaid.set(family.option.toLowerCase(), family);
        }

        if(family.overlayOnly) {

          continue;
        }

        for(const scope of scopes.values()) {

          const emission = compositionAt({ configIndex, family, scope });

          if(emission !== undefined) {

            emissions.push(emission);
          }
        }
      }

      return {

        configuredOptions: rewrite({ configuredOptions, consumed, emissions }),
        selection: ({ controller, device, domain, option }): readonly string[] | undefined => {

          const family = overlaid.get(option.toLowerCase());

          if(!family) {

            return undefined;
          }

          return selectValues({ domain, multiple: true, value: formatValueList(compose({ configIndex, controller, device, family })) }).selected;
        },
        translated
      };
    }
  };
}
