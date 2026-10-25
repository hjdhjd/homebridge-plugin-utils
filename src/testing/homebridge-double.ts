/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * testing/homebridge-double.ts: A Homebridge test double that runs Homebridge's own PlatformAccessory, API and bridge service over the hap-nodejs copy Homebridge
 * loads, with change and warning capture on every accessory it makes, Homebridge's server log kept off the console with its warnings held until a test takes
 * them, and HomeKit's read and write paths.
 */

/**
 * A Homebridge test double built on the real thing.
 *
 * hap-nodejs builds services, characteristics and accessories with no storage, no bridge server, no mDNS and no referenced handle, and Homebridge's
 * `PlatformAccessory` is a thin wrapper over a HAP accessory, so a faithful double needs no hand-built model of HAP or Homebridge: {@link loadHomebridge} hands a
 * suite the HAP namespace and the classes Homebridge itself runs, {@link TestHomebridgeApi} stands in for the API Homebridge hands a plugin by running Homebridge's
 * own API and bridge service behind it, and {@link triggerGet} and {@link triggerSet} drive a characteristic the way a HomeKit controller's read and write requests
 * do. A refused request rejects with a {@link HomeKitRequestError} carrying HAP's status and whether a handler faulted, which {@link hapStatus} reads, and
 * {@link hasGetHandler} and {@link hasSetHandler} tell a suite whether those requests have plugin code to call. {@link watchServerWarnings} builds a suite's API
 * doubles and checks each after every test, once the test's own cleanups have run, through {@link assertNoServerWarnings}, which fails a test that left untaken
 * a warning Homebridge logged on an API double, or a warning or an error HAP raised on an accessory the double made.
 *
 * The loader resolves Homebridge from the caller's location and requires hap-nodejs from Homebridge's own entry point, because the copy a plugin's handlers meet at
 * runtime is the one Homebridge loads, and a plugin's tree can hold another. HAP recognizes a status error by `instanceof` against its own copy's class, so a
 * suite running on any other copy sees a handler's status turn into a generic communication failure. The same resolution reaches the classes: Homebridge's
 * `exports` field opens only its index, which exports `PlatformAccessory` and `Logger` as types alone and Homebridge's API class and bridge service not at all, so
 * the loader imports `dist/platformAccessory.js`, `dist/api.js`, `dist/bridgeService.js` and `dist/logger.js` by file URL from Homebridge's own directory, which
 * package exports do not govern. The accessory, API and bridge service modules import hap-nodejs themselves, and it resolves to the very module the loader
 * required, so the classes and the namespace a suite holds share one HAP. A Homebridge release that moves one of those files or renames its export stops the
 * loader with a sentence naming what it looked for, at load rather than at the first accessory.
 *
 * This module reaches Homebridge and hap-nodejs only inside {@link loadHomebridge}, and only from the caller's tree: every other reference to them is a type,
 * so importing the testing entry point loads neither.
 *
 * {@link TestHomebridgeApi} answers the part of Homebridge's `API` a plugin's accessory code reaches, the HAP namespace, the `platformAccessory` class, the
 * accessory calls and the lifecycle events, and leaves out the rest, such as `registerPlatform`, `user` and `version`, so the compiler does not take it for an
 * `API`. Code that declares only the part of the API it reaches, as {@link accessory-persistence!AccessoryPersistence | AccessoryPersistence} does, takes the
 * double directly. A suite hands it to code that takes the whole `API`, such as a platform's constructor, with a cast at the rig boundary, the one place the suite
 * decides what the code under test can reach:
 *
 * ```ts
 * import { loadHomebridge, watchServerWarnings } from "homebridge-plugin-utils/testing";
 * import type { API } from "homebridge";
 * import { ExamplePlatform } from "../src/platform.ts";
 *
 * const setup = watchServerWarnings(await loadHomebridge(import.meta.url));
 * const api = setup();
 * const platform = new ExamplePlatform(log, config, api as unknown as API);
 * ```
 *
 * Every accessory the API double makes records what HAP raises on it. Value changes are heard on each service's own `characteristic-change` event, which HAP
 * raises whether the accessory is bridged or not, rather than on the accessory, which HAP raises its change event on only while the accessory is bridged, and
 * which the bridge's removal strips of every listener. Characteristic warnings are heard on the accessory, where a listener also keeps HAP from printing them.
 * HAP's name check is the exception: it prints straight to the console from the accessory and service constructors, outside the warning channel, so no
 * listener captures it.
 *
 * {@link assertNoServerWarnings} describes which warnings in that record fail the check after each test, and how a test takes the ones it expects.
 *
 * @module
 */
import type { API, AccessoryCharacteristicChange, AccessoryEventTypes, BridgeConfiguration, Categories, Characteristic, CharacteristicEventTypes,
  CharacteristicValue, DynamicPlatformPlugin, HAP, HomebridgeOptions, LogLevel, Logger, PlatformAccessory, PlatformName, PluginIdentifier, Service,
  ServiceCharacteristicChange, ServiceEventTypes, UnknownContext, WithUUID } from "homebridge";
import type { CharacteristicWarning, HAPConnection } from "@homebridge/hap-nodejs";
import { CharacteristicWarningType, HAPStatus, Perms } from "../homebridge-enums.ts";
import { dirname, join } from "node:path";
import { format, stripVTControlCharacters } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { EventEmitter } from "node:events";
import { afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

// HAP's event names, each checked against the member of HAP's own const enum that names it, the form the `APIEvent` mirror in `homebridge-enums.ts` documents, so a
// value that drifts from upstream fails the build here. The constants stay plain strings, because HAP's listener signatures take the string itself.
const CHARACTERISTIC_CHANGE = "characteristic-change" satisfies `${ServiceEventTypes.CHARACTERISTIC_CHANGE}`;
const CHARACTERISTIC_GET = "get" satisfies `${CharacteristicEventTypes.GET}`;
const CHARACTERISTIC_SET = "set" satisfies `${CharacteristicEventTypes.SET}`;
const CHARACTERISTIC_WARNING = "characteristic-warning" satisfies `${AccessoryEventTypes.CHARACTERISTIC_WARNING}`;

/* The connection a triggered request arrives on. HAP's characteristic request paths read nothing off it: they hand it to the characteristic's handlers and stamp
 * it as the originator of the change a request raises. Its presence is what marks a write as a controller's, because HAP validates a client-supplied value only
 * when a connection accompanies it. One frozen stand-in serves every request, so a suite can tell a triggered change from a plugin's own by its originator.
 */
const CONNECTION = Object.freeze({}) as unknown as HAPConnection;

// HBPU's mirror of HAP's statuses, keyed by number, through which a request path's numeric rejection becomes the member of the mirror it names. The mirror's type
// admits the names a numeric enum maps its values back to, which its plain object lacks, so the filter keeps the numbers the type promises.
const HAP_STATUSES = new Map(Object.values(HAPStatus).filter((value) => typeof value === "number").map((status): [number, HAPStatus] => [ status, status ]));

// The step that hears an accessory's warnings again, for every accessory any API double made. HAP's bridge removal strips an accessory of every listener, and the
// API that removed it, whichever API made it, calls this afterward. Keyed weakly, so an accessory a suite lets go of leaves no entry behind.
const rewatchWarnings = new WeakMap<PlatformAccessory, () => void>();

// The configuration of the bridge Homebridge's bridge service builds. Nothing publishes the bridge, so the username and setup code Homebridge's configuration requires
// are never advertised.
const BRIDGE_CONFIGURATION: BridgeConfiguration = Object.freeze({ name: "Homebridge", pin: "031-45-154", username: "0E:00:00:00:00:00" });

// The external port service the bridge service holds. Homebridge asks it for a port only when it publishes an external accessory, and it has no requestPort, so a
// publish that reached the service would fail rather than take a port.
const EXTERNAL_PORTS = Object.freeze({});

// The platform the plugin stand-in answers for a platform name no restore named, as a plugin's platform with nothing to configure. A registration under such a name
// needs it, because Homebridge warns when it finds no active platform, and its configureAccessory never runs, because a restore names its own platform first.
const IDLE_PLATFORM: Pick<DynamicPlatformPlugin, "configureAccessory"> = Object.freeze({ configureAccessory: (): void => undefined });

// The event Homebridge's API raises for a publish, which the bridge service listens on to advertise external accessories. Homebridge's index does not export the
// enum naming it, so the publish row's assertion that nothing reaches the service is what fails when a release renames it.
const PUBLISH_EXTERNAL_ACCESSORIES = "publishExternalAccessories";

// One of the double's calls in progress: the serverLog of the API whose call it is, as that API writes it, and the warn and error lines logged during the call or
// any call nested inside it.
interface ServerFrame {

  readonly log: HomebridgeServerLogLine[];
  readonly warnings: HomebridgeServerLogLine[];
}

// A frame for each of the double's calls in progress, the innermost last, shared by every API double in the process because one call can run inside another's,
// such as a registration from inside the configureAccessory a restore calls.
const serverFrames: ServerFrame[] = [];

// The internal loggers whose output already goes to the frames, one for each Homebridge copy an API double was built over. Keyed weakly, so a copy a suite lets go
// of leaves no entry behind.
const routedLoggers = new WeakSet<Logger>();

// The folders every API double in the process keeps its accessory cache in, each removed when the process exits.
const cacheFolders: string[] = [];

/**
 * What {@link loadHomebridge} resolves from a caller's tree: the HAP namespace and the classes Homebridge itself loads there.
 *
 * @category Testing
 */
export interface HomebridgeRuntime {

  /**
   * Homebridge's own `BridgeService` class, loaded from Homebridge's directory: the server half that caches, saves, bridges and restores a plugin's accessories,
   * which {@link TestHomebridgeApi} builds one of for each API double.
   */
  readonly BridgeService: HomebridgeBridgeServiceClass;

  /**
   * Homebridge's own `HomebridgeAPI` class, loaded from Homebridge's directory: the API Homebridge hands a plugin, whose accessory calls check and stamp what they
   * are handed before its bridge service handles them.
   */
  readonly HomebridgeAPI: HomebridgeApiClass;

  /**
   * Homebridge's own `Logger` class, loaded from Homebridge's directory, whose internal logger Homebridge's API and bridge service log through.
   */
  readonly Logger: HomebridgeLoggerClass;

  /**
   * Homebridge's own `PlatformAccessory` class, loaded from Homebridge's directory, whose accessories wrap accessories of {@link HomebridgeRuntime.hap}.
   */
  readonly PlatformAccessory: typeof PlatformAccessory;

  /**
   * The hap-nodejs namespace Homebridge loads, the same one a plugin reaches as `api.hap`.
   */
  readonly hap: HAP;
}

/**
 * The part of Homebridge's API that {@link TestHomebridgeApi} reaches on the `HomebridgeAPI` it builds: the accessory calls a plugin makes, each checking and
 * stamping what it is handed before Homebridge's bridge service handles it, and the removal of an event's listeners. Homebridge's index exports no type for the
 * class, so this lists only what the double touches.
 *
 * @category Testing
 */
export interface HomebridgeServerApi extends Pick<API, "publishExternalAccessories" | "registerPlatformAccessories" | "unregisterPlatformAccessories" |
  "updatePlatformAccessories"> {

  /**
   * Remove every listener of an event, as Node's `EventEmitter` does, which takes the bridge service's publish listener off.
   *
   * @param event - The event whose listeners to remove.
   *
   * @returns The API.
   */
  removeAllListeners(event: string): this;
}

/**
 * Homebridge's `HomebridgeAPI` class as {@link HomebridgeRuntime} carries it: a constructor taking nothing, whose instance a bridge service is built over.
 *
 * @category Testing
 */
export type HomebridgeApiClass = new () => HomebridgeServerApi;

/**
 * The part of Homebridge's bridge service that {@link TestHomebridgeApi} reaches on the `BridgeService` it builds: the accessory cache, the mark its save checks,
 * and its restore loop. Homebridge's declaration keeps the cache and the mark private, so no compile-time check reaches them, and the double's own suite is what
 * fails when a release renames one of them.
 *
 * @category Testing
 */
export interface HomebridgeBridgeService {

  /**
   * Whether the service has tried to load its accessory cache from disk, which its save checks before it writes, so a cache never loaded is never overwritten.
   */
  cachedAccessoriesFileLoaded: boolean;

  /**
   * The accessory cache: what a registration skips as a duplicate, what a save writes, and what the restore loop restores.
   */
  cachedPlatformAccessories: PlatformAccessory[];

  /**
   * Restore every accessory the cache holds, as Homebridge's server does at startup.
   */
  restoreCachedPlatformAccessories(): void;
}

/**
 * The part of Homebridge's plugin manager a bridge service reaches, which {@link TestHomebridgeApi} hands its bridge service a stand-in for: the plugin an
 * accessory is stamped with, answering its identifier, which Homebridge's characteristic warning printer names, and the active platform of a name, which
 * Homebridge's restore loop hands each accessory to.
 *
 * @category Testing
 */
export interface HomebridgePluginManager {

  /**
   * Answer the plugin of an identifier.
   *
   * @param pluginIdentifier - The identifier an accessory is stamped with.
   *
   * @returns The plugin, answering its identifier and the active platform of a platform name.
   */
  getPlugin(pluginIdentifier: PluginIdentifier): { getActiveDynamicPlatform(platformName: PlatformName): Pick<DynamicPlatformPlugin, "configureAccessory">;
    getPluginIdentifier(): PluginIdentifier; };
}

/**
 * Homebridge's `BridgeService` class as {@link HomebridgeRuntime} carries it: a constructor taking the API whose accessory calls the service handles, the plugin
 * manager it asks for each accessory's plugin, the external port service it asks for a published accessory's port, Homebridge's options with the folder the
 * service keeps its accessory cache in and the names of the items it writes there, and the configuration of the bridge it builds.
 *
 * @category Testing
 */
export type HomebridgeBridgeServiceClass = new (api: HomebridgeServerApi, pluginManager: HomebridgePluginManager, externalPortService: object,
  bridgeOptions: HomebridgeOptions & { cachedAccessoriesDir: string; cachedAccessoriesItemName: string; externalAccessoriesItemName: string },
  bridgeConfig: BridgeConfiguration) => HomebridgeBridgeService;

/**
 * The part of Homebridge's `Logger` class that {@link TestHomebridgeApi} reaches: the internal logger Homebridge's API and bridge service log through, and whether
 * Homebridge prints debug lines, which `Logger.setDebugEnabled` turns on. Homebridge's declaration keeps the debug flag private, so no compile-time check reaches it.
 *
 * @category Testing
 */
export interface HomebridgeLoggerClass {

  /**
   * Whether Homebridge prints its debug lines.
   */
  readonly debugEnabled: boolean;

  /**
   * Homebridge's internal logger, one for each Homebridge copy.
   */
  readonly internal: Logger;
}

/**
 * One line of {@link TestHomebridgeApi.serverLog}: a line Homebridge's server logged, with Homebridge's level and its message as Homebridge would print it, without
 * its timestamp or colors.
 *
 * @category Testing
 */
export interface HomebridgeServerLogLine {

  /**
   * The level Homebridge logged the line at.
   */
  readonly level: `${LogLevel}`;

  /**
   * The line as Homebridge formats it, its parameters substituted and its escape codes stripped.
   */
  readonly message: string;
}

/**
 * The failure of one of {@link TestHomebridgeApi}'s calls, or of its construction, during which Homebridge's server logged a warning or an error: an Error whose
 * message quotes those lines and which carries them.
 *
 * Homebridge carries on past what it warns of, skipping a duplicate registration, orphaning an accessory it cannot restore or failing to save its cache, so a plugin
 * that triggers one of those runs on under Homebridge with only a line in the log to show for it. The double throws instead, once Homebridge has finished the call,
 * so a suite meets the warning where the call was made.
 *
 * The throw takes nothing from the double's held set: each line stays held by the API whose call logged it until a test takes it through
 * {@link TestHomebridgeApi.takeServerWarnings}, and {@link assertNoServerWarnings} fails a test that left one, a warning plugin code caught included.
 *
 * @category Testing
 */
export class HomebridgeServerWarning extends Error {

  /**
   * The warn and error lines Homebridge logged during the call or any call nested inside it, in the order it logged them.
   */
  public readonly lines: readonly HomebridgeServerLogLine[];

  public override readonly name = "HomebridgeServerWarning" as const;

  /**
   * Create the failure of a call during which Homebridge logged the given lines.
   *
   * @param lines - The warn and error lines Homebridge logged.
   */
  public constructor(lines: readonly HomebridgeServerLogLine[]) {

    super("Homebridge's server logged a warning or an error during the call.\n" + quoteServerLines(lines));

    this.lines = lines;
  }
}

/**
 * An accessory made through {@link TestHomebridgeApi.platformAccessory}: Homebridge's own `PlatformAccessory`, carrying a record of every value change and
 * characteristic warning HAP raises on it.
 *
 * `changes` gains one entry for every change event HAP raises on a service of the accessory, from the moment the service joins it, whether the accessory is
 * bridged, unregistered or neither. Each entry is HAP's own change with the service it was raised on: the characteristic, the value before and after, HAP's reason
 * (`"update"`, `"write"`, `"read"` or `"event"`) and the originator, which is the trigger's connection stand-in for a change {@link triggerGet} or
 * {@link triggerSet} raised. HAP raises a change for a write of an unchanged value too, so an unchanged write is recorded, and a read is recorded only when it
 * changed the value. What HAP writes while it builds the accessory precedes the record, so a new accessory's `changes` starts empty. What a service is given
 * before it joins precedes the record too, so the name {@link service!acquireService | acquireService} writes on a service it creates, before adding it, is not
 * recorded.
 *
 * `warnings` gains one entry for every characteristic warning the accessory raises, stored as it read when it was raised, its originator chain copied, so a
 * bridge that rewrites the chain afterward changes nothing recorded. Capturing a warning keeps HAP from printing it, so a suite's console stays quiet.
 * {@link assertNoServerWarnings} describes which recorded warnings fail the check after each test, and how a test takes the ones it expects.
 *
 * @typeParam T - The accessory's context type, as Homebridge's own class declares it.
 *
 * @category Testing
 */
export interface TestPlatformAccessory<T extends UnknownContext = UnknownContext> extends PlatformAccessory<T> {

  /**
   * Every value change HAP raised on the accessory's services, in the order HAP raised them.
   */
  readonly changes: readonly AccessoryCharacteristicChange[];

  /**
   * Every characteristic warning the accessory raised since the last take or clear, in the order it raised them. A suite filters them by kind through
   * {@link homebridge-enums!CharacteristicWarningType | CharacteristicWarningType}.
   *
   * {@link assertNoServerWarnings} reads this record after each test, and describes which warnings in it fail the check and how a test takes the ones it expects.
   */
  readonly warnings: readonly CharacteristicWarning[];

  /**
   * The recorded changes to any of the given characteristics, matched by the characteristic class's `UUID`, in the order HAP raised them.
   *
   * @param characteristics - The characteristic classes to select, such as `hap.Characteristic.On`.
   *
   * @returns The matching entries of {@link TestPlatformAccessory.changes}.
   */
  changesTo(...characteristics: WithUUID<new () => Characteristic>[]): AccessoryCharacteristicChange[];

  /**
   * The recorded changes HAP raised on one service, in the order HAP raised them, limited to the given characteristics, matched by the characteristic class's `UUID`,
   * when any are named.
   *
   * @param service         - The service whose changes to select, matched by identity.
   * @param characteristics - The characteristic classes to select among the service's changes, such as `hap.Characteristic.On`. Naming none selects every change
   *                          the service raised.
   *
   * @returns The matching entries of {@link TestPlatformAccessory.changes}.
   */
  changesOn(service: Service, ...characteristics: WithUUID<new () => Characteristic>[]): AccessoryCharacteristicChange[];

  /**
   * Empty {@link TestPlatformAccessory.changes} and {@link TestPlatformAccessory.warnings}, so a suite reads only what follows. The accessory keeps recording.
   */
  clearObservations(): void;

  /**
   * Take the warnings the accessory recorded since the last take or clear, emptying {@link TestPlatformAccessory.warnings}, so a later take answers only what the
   * accessory raises after this one. A test that expects HAP to warn takes the warnings it expects here, because {@link assertNoServerWarnings} takes whatever
   * the record still holds after the test and fails the test on a warning of a failing kind. The accessory keeps recording.
   *
   * @returns Every warning recorded since the last take or clear, in the order the accessory raised them, none of which a later take answers again.
   */
  takeWarnings(): readonly CharacteristicWarning[];
}

/**
 * The class {@link TestHomebridgeApi.platformAccessory} holds: Homebridge's `PlatformAccessory` constructor, generic over the context as Homebridge's own is, whose
 * instances are {@link TestPlatformAccessory} accessories.
 *
 * @category Testing
 */
export type TestPlatformAccessoryConstructor =
  (new <T extends UnknownContext = UnknownContext>(displayName: string, uuid: string, category?: Categories) => TestPlatformAccessory<T>) & typeof PlatformAccessory;

/**
 * One entry of {@link TestHomebridgeApi.calls}: an accessory call a plugin made and Homebridge accepted, tagged by `kind`, carrying a copy of the accessories it
 * was handed and, where Homebridge's own signature takes them, the plugin identifier and the platform name.
 *
 * @category Testing
 */
export type TestHomebridgeApiCall =
  { readonly accessories: readonly PlatformAccessory[]; readonly kind: "publish"; readonly pluginIdentifier: PluginIdentifier } |
  { readonly accessories: readonly PlatformAccessory[]; readonly kind: "register" | "unregister"; readonly platformName: PlatformName;
    readonly pluginIdentifier: PluginIdentifier; } |
  { readonly accessories: readonly PlatformAccessory[]; readonly kind: "update" };

/**
 * What {@link TestHomebridgeApi.restorePlatformAccessories} restores: the cached accessories, the platform Homebridge hands each one to, and the plugin identifier
 * and platform name it stamps on them.
 *
 * @category Testing
 */
export interface TestHomebridgeRestoreOptions {

  /**
   * The cached accessories to restore, in the order Homebridge restores them.
   */
  readonly accessories: readonly PlatformAccessory[];

  /**
   * The platform whose `configureAccessory` sees each accessory after Homebridge's FirmwareRevision placeholder and before the bridge: the plugin's own platform,
   * or a stand-in when the suite has none. Homebridge finds it as the active platform of the platform name, and does from then on.
   */
  readonly platform: Pick<DynamicPlatformPlugin, "configureAccessory">;

  /**
   * The platform the accessories belong to.
   */
  readonly platformName: PlatformName;

  /**
   * The plugin's identifier.
   */
  readonly pluginIdentifier: PluginIdentifier;
}

/**
 * Resolve Homebridge from a caller's tree and load the hap-nodejs copy and the classes Homebridge itself runs there: `PlatformAccessory`, `HomebridgeAPI`,
 * `BridgeService` and `Logger`.
 *
 * Homebridge is resolved from `from` the way a `require` there would resolve it, hap-nodejs is required from Homebridge's resolved entry point, and each class is
 * imported by file URL from the module in the same directory that defines it, `PlatformAccessory` first. A step that fails rejects with an Error naming what it
 * looked for and where, the original failure as its `cause`, and so does a module that loads without its class among its exports.
 *
 * @param from - Where to resolve Homebridge from: the calling module's `import.meta.url`, or any file URL or absolute file path inside the tree the suite runs in.
 *
 * @returns The HAP namespace and the classes Homebridge loads from that tree.
 *
 * @example
 *
 * ```ts
 * import { loadHomebridge, watchServerWarnings } from "homebridge-plugin-utils/testing";
 *
 * // Every API double the file builds over the runtime through setup is checked after each test, once that test's own cleanups have run.
 * const runtime = await loadHomebridge(import.meta.url);
 * const setup = watchServerWarnings(runtime);
 * const api = setup();
 * ```
 *
 * @category Testing
 */
export async function loadHomebridge(from: string | URL): Promise<HomebridgeRuntime> {

  const entry = await loadStep("The homebridge package could not be resolved from " + String(from) + ".", () => createRequire(from).resolve("homebridge"));
  const hap = await loadStep("The hap-nodejs package could not be required from Homebridge's entry point at " + entry + ".",
    () => createRequire(entry)("@homebridge/hap-nodejs") as HAP);
  const directory = dirname(entry);
  const platformAccessoryClass = await loadClass({ directory, file: "platformAccessory.js", name: "PlatformAccessory" }) as typeof PlatformAccessory;
  const apiClass = await loadClass({ directory, file: "api.js", name: "HomebridgeAPI" }) as HomebridgeApiClass;
  const bridgeServiceClass = await loadClass({ directory, file: "bridgeService.js", name: "BridgeService" }) as HomebridgeBridgeServiceClass;
  const loggerClass = await loadClass({ directory, file: "logger.js", name: "Logger" }) as HomebridgeLoggerClass;

  return { BridgeService: bridgeServiceClass, HomebridgeAPI: apiClass, Logger: loggerClass, PlatformAccessory: platformAccessoryClass, hap };
}

// Import one of Homebridge's modules by file URL from its directory and answer the class it exports under the given name, rejecting with a sentence naming the
// module when it cannot be imported or exports no class under that name.
async function loadClass({ directory, file, name }: { directory: string; file: string; name: string }): Promise<unknown> {

  const moduleUrl = pathToFileURL(join(directory, file)).href;
  const exported = await loadStep("Homebridge's " + name + " module could not be imported from " + moduleUrl + ".",
    async () => await import(moduleUrl) as Record<string, unknown>);

  if(typeof exported[name] !== "function") {

    throw new Error("Homebridge's module at " + moduleUrl + " does not export the " + name + " class.");
  }

  return exported[name];
}

// Run one step of the load, rewrapping its failure in a sentence that names what the step looked for and where, with the original failure as the cause.
async function loadStep<T>(failure: string, step: () => T | Promise<T>): Promise<T> {

  try {

    return await step();
  } catch(error) {

    throw new Error(failure, { cause: error });
  }
}

/* Make the class TestHomebridgeApi.platformAccessory holds: a subclass of the runtime's PlatformAccessory, made once per API so each API lists the accessories made
 * through it. The constructor listens on every service the HAP accessory carries and every service added later, and on the accessory's warnings, then registers
 * the step that listens for its warnings again once a bridge removal has stripped the listener.
 */
function observedAccessoryClass(runtime: HomebridgeRuntime, accessories: TestPlatformAccessory[]): TestPlatformAccessoryConstructor {

  return class ObservedPlatformAccessory<T extends UnknownContext = UnknownContext> extends runtime.PlatformAccessory<T> implements TestPlatformAccessory<T> {

    public readonly changes: AccessoryCharacteristicChange[] = [];

    public readonly warnings: CharacteristicWarning[] = [];

    // One change listener for each service, kept so the listener a service carries can be recognized. HAP strips a removed service of every listener, so a service
    // re-added after a removal is heard again, while one that left the services array some other way still carries its listener and is not heard twice.
    readonly #changeListeners = new WeakMap<Service, (change: ServiceCharacteristicChange) => void>();

    // HAP's bridge rewrites the warning's originator chain after this listener has run, so the entry is copied as it reads at capture, its chain included.
    readonly #captureWarning = (warning: CharacteristicWarning): void => {

      this.warnings.push({ ...warning, originatorChain: [...warning.originatorChain] });
    };

    public constructor(displayName: string, uuid: string, category?: Categories) {

      super(displayName, uuid, category);

      const hapAccessory = this._associatedHAPAccessory;
      const addService: (...args: unknown[]) => Service = hapAccessory.addService.bind(hapAccessory);

      // Every path by which HAP adds a service to an accessory goes through the instance's addService, Homebridge's forwarder and a controller's configuration
      // included, so a wrapper there hears each service as it joins. HAP's own method takes a service or a service class with its arguments, and the wrapper
      // hands it whatever it was handed.
      hapAccessory.addService = (...args: unknown[]): Service => {

        const service = addService(...args);

        this.#watchService(service);

        return service;
      };

      for(const service of hapAccessory.services) {

        this.#watchService(service);
      }

      this.#watchWarnings();
      rewatchWarnings.set(this, () => this.#watchWarnings());
      accessories.push(this);
    }

    public changesTo(...characteristics: WithUUID<new () => Characteristic>[]): AccessoryCharacteristicChange[] {

      return this.changes.filter((change) => characteristics.some((characteristic) => characteristic.UUID === change.characteristic.UUID));
    }

    public changesOn(service: Service, ...characteristics: WithUUID<new () => Characteristic>[]): AccessoryCharacteristicChange[] {

      return ((characteristics.length > 0) ? this.changesTo(...characteristics) : this.changes).filter((change) => change.service === service);
    }

    public clearObservations(): void {

      this.changes.length = 0;
      this.warnings.length = 0;
    }

    public takeWarnings(): readonly CharacteristicWarning[] {

      return this.warnings.splice(0);
    }

    // Listen for the service's changes, unless the service already carries this accessory's listener.
    #watchService(service: Service): void {

      let listener = this.#changeListeners.get(service);

      if(!listener) {

        listener = (change: ServiceCharacteristicChange): void => {

          this.changes.push({ ...change, service });
        };

        this.#changeListeners.set(service, listener);
      }

      if(!service.listeners(CHARACTERISTIC_CHANGE).includes(listener)) {

        service.on(CHARACTERISTIC_CHANGE, listener);
      }
    }

    // Listen for the accessory's warnings, unless the accessory already carries the listener.
    #watchWarnings(): void {

      const hapAccessory = this._associatedHAPAccessory;

      if(!hapAccessory.listeners(CHARACTERISTIC_WARNING).includes(this.#captureWarning)) {

        hapAccessory.on(CHARACTERISTIC_WARNING, this.#captureWarning);
      }
    }
  };
}

// Whether a line Homebridge's server logged is a warning: a line at warn or error level. A call's strict throw and an API's held set each read it through here,
// so the throw and the check after each test agree on what a warning is.
function isServerWarning({ level }: HomebridgeServerLogLine): boolean {

  return (level === "error") || (level === "warn");
}

// The lines as an error's message quotes them, one to a line, each after Homebridge's level.
function quoteServerLines(lines: readonly HomebridgeServerLogLine[]): string {

  return lines.map(({ level, message }) => level + ": " + message).join("\n");
}

// Whether a characteristic warning fails the check after each test: a kind that reports a defect in the plugin. Homebridge treats a slow request and a debug
// message as advice, so those pass.
function isFailingWarning({ type }: CharacteristicWarning): boolean {

  // Every kind below returns and the switch carries no default arm: with every kind answered the compiler proves the switch total, so a kind HAP adds fails to
  // compile here until it is placed on one side, rather than taking an answer no one chose for it.
  switch(type) {

    case CharacteristicWarningType.ERROR_MESSAGE:
    case CharacteristicWarningType.TIMEOUT_READ:
    case CharacteristicWarningType.TIMEOUT_WRITE:
    case CharacteristicWarningType.WARN_MESSAGE: {

      return true;
    }

    case CharacteristicWarningType.DEBUG_MESSAGE:
    case CharacteristicWarningType.SLOW_READ:
    case CharacteristicWarningType.SLOW_WRITE: {

      return false;
    }
  }
}

// The warnings as an error's message quotes them, one to a line, each after its kind, naming the characteristic and the accessory it was raised on.
function quoteAccessoryWarnings(warnings: readonly { accessory: TestPlatformAccessory; warning: CharacteristicWarning }[]): string {

  return warnings.map(({ accessory, warning: { characteristic, message, type } }) => type + ": characteristic '" + characteristic.displayName + "' of accessory '" +
    accessory.displayName + "': " + message).join("\n");
}

/* Send the lines one Homebridge copy's internal logger logs to the frames of the double's calls rather than to the console. Homebridge's API and bridge service log
 * through Logger.internal, one logger for each Homebridge copy, and its log method reads the console only when it runs, so an own log method on that one instance
 * catches every line they log and leaves the console, and every other logger Homebridge makes, as they were. It is installed once for each internal logger, by the
 * first API double built over that copy, and stays for the life of the process, so a line Homebridge logs outside every call of the double is dropped rather than
 * printed. Homebridge's own log method holds its debug gate, which this one replaces, so a debug line is kept only while Homebridge's debug is on.
 */
function routeServerLog(loggerClass: HomebridgeLoggerClass): void {

  const { internal } = loggerClass;

  if(routedLoggers.has(internal)) {

    return;
  }

  routedLoggers.add(internal);

  internal.log = (level: `${LogLevel}`, message: string, ...parameters: unknown[]): void => {

    const frame = serverFrames.at(-1);

    if(!frame || ((level === "debug") && !loggerClass.debugEnabled)) {

      return;
    }

    const line = { level, message: stripVTControlCharacters(format(message, ...parameters)) };

    frame.log.push(line);

    if(isServerWarning(line)) {

      frame.warnings.push(line);
    }
  };
}

/* Make the folder one API double's bridge service keeps its accessory cache in, under the system temp folder rather than the machine's Homebridge folder, so a
 * suite never reads or writes a real install's cache. The first folder a process makes registers the one exit listener that removes them all, so importing this
 * module registers nothing. Node runs an exit listener on a normal exit and on process.exit, and not when a signal kills the process, so a runner's timeout or a
 * Ctrl-C leaves that run's folders behind.
 */
function makeCacheFolder(): string {

  const folder = mkdtempSync(join(tmpdir(), "hbpu-homebridge-cache-"));

  if(cacheFolders.push(folder) === 1) {

    process.on("exit", (): void => {

      for(const cached of cacheFolders) {

        rmSync(cached, { force: true, recursive: true });
      }
    });
  }

  return folder;
}

/**
 * A Homebridge API double over the runtime {@link loadHomebridge} resolved, running Homebridge's own API and bridge service behind the API Homebridge hands a
 * plugin.
 *
 * `hap` is the runtime's HAP namespace, and `platformAccessory` a subclass of Homebridge's own `PlatformAccessory` whose instances are
 * {@link TestPlatformAccessory} accessories, each listed in `accessories` as it is made. Each API double builds a `HomebridgeAPI` and a `BridgeService` of its own
 * from the runtime, composed rather than extended, because Homebridge's API carries a `user` whose storage path is the machine's real Homebridge folder. The
 * accessory calls go through that API, which checks and stamps what it is handed with Homebridge's own refusals and sentences, to that service, which caches,
 * saves, skips a duplicate with a warning, bridges, unregisters and restores as Homebridge's server does, and each call Homebridge accepted is recorded in `calls`.
 * Around Homebridge's own code the double adds what a suite needs:
 *
 *   - The service keeps its accessory cache in a temporary folder of its own, made under the system temp folder and removed when the process exits. A process a
 *     signal kills, as a runner's timeout or a Ctrl-C kills one, runs no exit listener and leaves its folders there.
 *   - The service starts with its cache marked loaded, the state Homebridge's startup load of an empty cache leaves, so it saves its cache on every registration,
 *     update and unregister, as Homebridge's server does.
 *   - Homebridge's plugin manager is a stand-in that answers every plugin identifier with a plugin answering that identifier and, for a platform name, the platform
 *     a restore named for it or a platform whose `configureAccessory` does nothing.
 *   - Nothing publishes on the network: the service's publish listener is removed, so a publish passes the API's checks and stamp, is recorded and goes no further,
 *     and the external port service the service holds has no `requestPort`, so a publish that reached it would fail rather than take a port.
 *   - Homebridge's internal logger writes nothing to the console. Each line it logs during one of the double's calls, or during the double's construction, is
 *     recorded in `serverLog`, and a line it logs outside every call is dropped.
 *
 * The double is strict. When the outermost of its calls ends as Homebridge ends it, and Homebridge logged a warning or an error during that call or any call nested
 * inside it, the call throws a {@link HomebridgeServerWarning} quoting those lines, after Homebridge has finished and after the call is recorded, and so does the
 * construction. A call made inside another, such as a registration from inside the `configureAccessory` a restore calls, records its lines and returns, so
 * Homebridge's restore loop runs on as it does under Homebridge, and the outermost call throws them. The throw reaches the code that made the call: a suite's own
 * call, a suite's `emit` of a lifecycle event whose listener made the call before returning, or plugin code that catches it. A call Homebridge refuses outright,
 * for an accessory that is not a `PlatformAccessory` or by HAP's refusal at the bridge, throws that refusal unchanged and is not recorded, and a line Homebridge
 * logged before the refusal stays in `serverLog`.
 *
 * The double also holds every warn and error line Homebridge logged on it until a test takes it, so a warning plugin code caught still fails the test that drew
 * it. {@link TestHomebridgeApi.takeServerWarnings} takes the lines, and {@link assertNoServerWarnings} fails the test when any is left, called by
 * {@link watchServerWarnings} for every API double a suite builds through it after each test, once the test's own cleanups have run. The strict throw takes
 * nothing, because the double cannot tell a suite's `assert.throws` from a plugin's `catch`, so a test that expects Homebridge to warn takes the lines it expects.
 * The same check reads the warnings every accessory made through `platformAccessory` records, and {@link assertNoServerWarnings} describes which of them fail it
 * and how a test takes the ones it expects.
 *
 * The calls accept any `PlatformAccessory`, as Homebridge's do, but only an accessory made through `platformAccessory` records its changes and warnings, so one
 * built from Homebridge's class directly records nothing.
 *
 * An accessory stays off the bridge until it is registered or restored, as under Homebridge, and
 * {@link accessory-persistence!AccessoryPersistence | AccessoryPersistence} saves and unregisters only accessories the bridge holds, so a suite registers or restores
 * an accessory before it expects the helper to save it. The helper gathers its saves into a window, so a suite counting the `update` entries in `calls` first steps
 * its `TestClock` by {@link accessory-persistence!ACCESSORY_SAVE_WINDOW_MS | ACCESSORY_SAVE_WINDOW_MS} or calls the helper's `flush()`.
 *
 * The class is an `EventEmitter`, as Homebridge's API is, so a plugin subscribes to `didFinishLaunching` and `shutdown` on it and a suite emits them. A suite
 * injects a failure into an accessory call with `t.mock.method` on the instance.
 *
 * @example
 *
 * ```ts
 * import { loadHomebridge, triggerSet, watchServerWarnings } from "homebridge-plugin-utils/testing";
 *
 * // The builder makes each API double and checks it after every test, so a warning plugin code caught fails the test that drew it.
 * const setup = watchServerWarnings(await loadHomebridge(import.meta.url));
 * const api = setup();
 * const accessory = new api.platformAccessory("Porch Light", api.hap.uuid.generate("porch-light"));
 * const on = accessory.addService(api.hap.Service.Lightbulb, "Porch Light").getCharacteristic(api.hap.Characteristic.On);
 *
 * api.registerPlatformAccessories("homebridge-example", "Example", [accessory]);
 *
 * await triggerSet(on, true);
 *
 * // One entry, the write HomeKit asked for, whether or not the accessory is bridged.
 * accessory.changesTo(api.hap.Characteristic.On);
 * ```
 *
 * @category Testing
 */
export class TestHomebridgeApi extends EventEmitter implements Pick<API, "hap" | "platformAccessory" | "publishExternalAccessories" | "registerPlatformAccessories" |
  "unregisterPlatformAccessories" | "updatePlatformAccessories"> {

  /**
   * Every accessory made through {@link TestHomebridgeApi.platformAccessory}, in the order it was made.
   */
  public readonly accessories: TestPlatformAccessory[] = [];

  /**
   * Every accessory call a plugin made on this API and Homebridge accepted, in arrival order, each tagged by `kind`. A call is recorded once Homebridge has handled
   * it and before a warning Homebridge logged during it throws, so a call Homebridge refuses outright, for an accessory that is not a `PlatformAccessory` or by
   * HAP's refusal at the bridge, throws that refusal and records nothing. A restore is Homebridge's act rather than the plugin's, so it records nothing.
   */
  public readonly calls: TestHomebridgeApiCall[] = [];

  /**
   * The runtime's HAP namespace, the one a plugin reaches as `api.hap`.
   */
  public readonly hap: HAP;

  /**
   * Homebridge's `PlatformAccessory`, extended so that each accessory it makes records its changes and warnings and joins
   * {@link TestHomebridgeApi.accessories}. It is generic over the context as Homebridge's own class is, so `new api.platformAccessory<Context>(...)` types the
   * accessory's context.
   */
  public readonly platformAccessory: TestPlatformAccessoryConstructor;

  readonly #api: HomebridgeServerApi;

  // The place in the server log the held set starts at: every warning before it has been taken, and only a take moves it.
  #heldFrom = 0;

  // The platform each restore named, by platform name, which the plugin stand-in answers as the active platform of that name.
  readonly #platforms = new Map<PlatformName, Pick<DynamicPlatformPlugin, "configureAccessory">>();

  // The server log as the frames of this API's calls write it, which serverLog hands a suite read-only.
  readonly #serverLog: HomebridgeServerLogLine[] = [];

  readonly #service: HomebridgeBridgeService;

  /**
   * Create an API double over a runtime {@link loadHomebridge} resolved.
   *
   * @param runtime - The HAP namespace and the classes the double runs on.
   */
  public constructor(runtime: HomebridgeRuntime) {

    super();

    // Homebridge's logger is routed before any of Homebridge's classes is built, so a line one logs while it is built reaches the construction's frame below and
    // never the console.
    routeServerLog(runtime.Logger);
    this.hap = runtime.hap;
    this.platformAccessory = observedAccessoryClass(runtime, this.accessories);

    // Every identifier has a plugin, which answers that identifier and, for a platform name, the platform a restore named for it or the idle one.
    const pluginManager: HomebridgePluginManager = {

      getPlugin: (pluginIdentifier) => ({

        getActiveDynamicPlatform: (platformName) => this.#platforms.get(platformName) ?? IDLE_PLATFORM,
        getPluginIdentifier: () => pluginIdentifier
      })
    };

    // Homebridge's API, its bridge service and the removal of the service's publish listener run in one frame, so a line Homebridge logs while its classes are
    // built lands in serverLog, and a warn or error line among them throws, as one logged during a call does.
    const server = this.#callServer(() => {

      const api = new runtime.HomebridgeAPI();
      const service = new runtime.BridgeService(api, pluginManager, EXTERNAL_PORTS, { cachedAccessoriesDir: makeCacheFolder(),
        cachedAccessoriesItemName: "cachedAccessories", externalAccessoriesItemName: "externalAccessories" }, BRIDGE_CONFIGURATION);

      // Homebridge's server loads the accessory cache at startup, before any plugin runs, and its save writes only once that load was attempted. A fresh folder
      // holds no cache, so the mark is the state that load leaves.
      service.cachedAccessoriesFileLoaded = true;
      api.removeAllListeners(PUBLISH_EXTERNAL_ACCESSORIES);

      return { api, service };
    });

    this.#api = server.api;
    this.#service = server.service;
  }

  /**
   * Every line Homebridge's server logged during this API's calls and its construction, in the order it logged them, each with Homebridge's level and its message
   * as Homebridge would print it, without its timestamp or colors. A line lands in the log of the API whose call logged it, so a call nested inside one of this
   * API's calls on another API double leaves its lines in that API's log. A debug line is kept only while Homebridge's debug is on, as Homebridge prints one only
   * then, and a line Homebridge logs outside every call of the double is dropped.
   *
   * A characteristic warning an accessory raises during a call reaches this log through the printer Homebridge attaches to each accessory it registers or restores,
   * which logs a `"warn-message"` warning at info, an `"error-message"` warning at error, and a `"debug-message"` warning and a warning's stack at debug, so of
   * those only an `"error-message"` warning throws. The printer logs a slow read or write at info and a timeout at error as well, but HAP reports each from a timer
   * while a controller's request is out, and reports a warning an async handler raises once the handler's promise settles, so none of those lands inside a call.
   * A warning raised outside every call, such as one a trigger draws, is dropped here and still recorded in the accessory's `warnings`.
   *
   * An `"error-message"` warning raised inside a call on an accessory Homebridge registered or restored is therefore held twice, as this log's line and in the
   * accessory's `warnings`, and a test that expects it takes the line and the warning. {@link assertNoServerWarnings} describes which warnings fail the check
   * after each test, and how a test takes the ones it expects.
   *
   * The log is read-only to a suite, because {@link TestHomebridgeApi.takeServerWarnings} holds its warnings by their place in it, and a log a suite shortened
   * would leave the warnings Homebridge logged after it unheld.
   */
  public get serverLog(): readonly HomebridgeServerLogLine[] {

    return this.#serverLog;
  }

  /**
   * Publish accessories outside the bridge through Homebridge's API, which checks each accessory and stamps it with the plugin identifier, logging at info when the
   * identifier is not a qualified plugin name, and the call is recorded. The service's publish listener is removed, so nothing is bridged, cached or advertised.
   *
   * @param pluginIdentifier - The plugin's identifier.
   * @param accessories      - The accessories to publish.
   */
  public publishExternalAccessories(pluginIdentifier: PluginIdentifier, accessories: PlatformAccessory[]): void {

    this.#callServer(() => {

      this.#api.publishExternalAccessories(pluginIdentifier, accessories);
      this.calls.push({ accessories: [...accessories], kind: "publish", pluginIdentifier });
    });
  }

  /**
   * Register accessories through Homebridge's API and bridge service: the API checks each accessory and stamps it with the plugin identifier and platform name,
   * and the service skips, with a warning, each accessory whose UUID it already caches or bridges, caches and bridges the rest, and saves its cache.
   *
   * @param pluginIdentifier - The plugin's identifier.
   * @param platformName     - The platform the accessories belong to.
   * @param accessories      - The accessories to register.
   */
  public registerPlatformAccessories(pluginIdentifier: PluginIdentifier, platformName: PlatformName, accessories: PlatformAccessory[]): void {

    this.#callServer(() => {

      this.#api.registerPlatformAccessories(pluginIdentifier, platformName, accessories);
      this.calls.push({ accessories: [...accessories], kind: "register", platformName, pluginIdentifier });
    });
  }

  /**
   * Restore cached accessories, as Homebridge's server does at startup, through Homebridge's own restore loop. Each accessory of the batch is stamped with the plugin
   * identifier and platform name, as the cache Homebridge loads holds it, the platform becomes the active platform of the platform name, and the service's cache
   * holds the batch alone while the loop runs. For each accessory of the batch the cache still holds when its turn comes, by identity, Homebridge writes its
   * FirmwareRevision placeholder of `"0"` through `setCharacteristic`, hands the accessory to the platform's `configureAccessory`, and bridges it once that call
   * returns, so an accessory an earlier `configureAccessory` unregistered, or swapped for a new instance of its UUID through an update, is skipped. An accessory
   * HAP refuses to bridge has been configured already, and Homebridge warns, orphans it out of the cache and restores the rest, so the restore throws that warning
   * once the loop ends. However the loop ends, the accessories the cache held before the restore, less the batch, then return to the cache ahead of what the loop
   * left there.
   *
   * A call made from inside `configureAccessory` acts on a cache holding the batch alone, as Homebridge's own cache holds its restored accessories and nothing a
   * plugin registered since: a registration of a UUID an accessory of the batch carries is skipped as a duplicate, an unregister leaves an accessory outside the
   * batch cached, an update leaves an accessory outside the batch that shares a UUID with one it is handed cached beside it, and a save writes the batch alone.
   *
   * The platform sees the placeholder, which a revision it writes replaces, on an accessory not yet on the bridge, and HAP raises a change for the placeholder's
   * write, so `changes` records it. Homebridge restores accessories without the plugin asking, so no call is recorded.
   *
   * @param options - The accessories, the platform that configures them, and the plugin identifier and platform name. See {@link TestHomebridgeRestoreOptions}.
   */
  public restorePlatformAccessories({ accessories, platform, platformName, pluginIdentifier }: TestHomebridgeRestoreOptions): void {

    this.#callServer(() => {

      for(const accessory of accessories) {

        accessory._associatedPlugin = pluginIdentifier;
        accessory._associatedPlatform = platformName;
      }

      this.#platforms.set(platformName, platform);

      const service = this.#service;
      const others = service.cachedPlatformAccessories.filter((cached) => !accessories.includes(cached));

      service.cachedPlatformAccessories = [...accessories];

      try {

        service.restoreCachedPlatformAccessories();
      } finally {

        service.cachedPlatformAccessories = [ ...others, ...service.cachedPlatformAccessories ];
      }
    });
  }

  /**
   * Take the warnings this API holds: the warn and error lines of {@link TestHomebridgeApi.serverLog} logged since the last take, in the order Homebridge logged
   * them.
   *
   * The held set is no list of its own. It is the part of `serverLog` past a cursor, which each take moves to the log's end, so a second take answers only what
   * Homebridge logged since the first, and `serverLog` itself keeps every line. A line a call nested on another API double logged is held by that API, whose log
   * holds it. A strict throw takes nothing: a {@link HomebridgeServerWarning} reaches whatever code made the call, and the double cannot tell a suite's
   * `assert.throws` from a plugin's `catch`, so a test that expects Homebridge to warn takes the lines itself, and {@link assertNoServerWarnings} fails a test
   * that left any.
   *
   * @returns The warn and error lines logged since the last take, none of which a later take answers again.
   */
  public takeServerWarnings(): readonly HomebridgeServerLogLine[] {

    const held = this.#serverLog.slice(this.#heldFrom).filter(isServerWarning);

    this.#heldFrom = this.#serverLog.length;

    return held;
  }

  /**
   * Unregister accessories through Homebridge's API and bridge service: the API checks each accessory, and the service removes each from its cache by identity
   * and from the bridge, and saves its cache. HAP refuses to remove an accessory the bridge does not hold, and that refusal reaches the caller, as it does from
   * Homebridge, with the cache already updated and no call recorded. The bridge's removal strips the accessory of every listener, as it does under Homebridge,
   * and the double hears the accessory's warnings again afterward.
   *
   * @param pluginIdentifier - The plugin's identifier.
   * @param platformName     - The platform the accessories belong to.
   * @param accessories      - The accessories to unregister.
   */
  public unregisterPlatformAccessories(pluginIdentifier: PluginIdentifier, platformName: PlatformName, accessories: PlatformAccessory[]): void {

    this.#callServer(() => {

      // The bridge strips each accessory it removes of every listener, the accessory's warning capture among them, and a refusal partway leaves the earlier
      // accessories stripped too, so every accessory handed over is heard again however the removal ends.
      try {

        this.#api.unregisterPlatformAccessories(pluginIdentifier, platformName, accessories);
      } finally {

        for(const accessory of accessories) {

          rewatchWarnings.get(accessory)?.();
        }
      }

      this.calls.push({ accessories: [...accessories], kind: "unregister", platformName, pluginIdentifier });
    });
  }

  /**
   * Save accessories through Homebridge's API and bridge service: the service puts the accessories it is handed in place of every cached accessory sharing a UUID
   * with one of them, caches the rest, registered or not, and saves its cache, and the call is recorded.
   *
   * Homebridge's save writes an accessory only once a registration or a restore has stamped it with its plugin and platform, and it writes the whole cache, so an
   * update of an accessory never registered or restored leaves one in the cache that no save can write, as it does under Homebridge: that update, and every call
   * that saves while that accessory stays cached, logs Homebridge's error and throws.
   *
   * @param accessories - The accessories to save.
   */
  public updatePlatformAccessories(accessories: PlatformAccessory[]): void {

    this.#callServer(() => {

      this.#api.updatePlatformAccessories(accessories);
      this.calls.push({ accessories: [...accessories], kind: "update" });
    });
  }

  /* Run one of the double's calls into Homebridge, or the double's construction, as a frame on the stack every API double shares, so each line Homebridge logs
   * during it lands in this API's serverLog. A frame that ends hands its warn and error lines to the frame it is nested in, whether its call returned or threw, and
   * the outermost frame whose call returned throws them. A nested frame never throws, because the code it returns to may be Homebridge's own, such as the restore
   * loop that called the plugin's configureAccessory, and a throw there would cut short what Homebridge carries on past. A call that threw passes its own throw
   * through unchanged.
   */
  #callServer<T>(call: () => T): T {

    const frame: ServerFrame = { log: this.#serverLog, warnings: [] };

    serverFrames.push(frame);

    let result: T;

    try {

      result = call();
    } finally {

      serverFrames.pop();
      serverFrames.at(-1)?.warnings.push(...frame.warnings);
    }

    if((serverFrames.length === 0) && (frame.warnings.length > 0)) {

      throw new HomebridgeServerWarning(frame.warnings);
    }

    return result;
  }
}

/**
 * Fail a test that left untaken a warning Homebridge logged on an API double, or a warning or an error HAP raised on an accessory the double made: take the
 * lines the API holds through {@link TestHomebridgeApi.takeServerWarnings} and the warnings each accessory in {@link TestHomebridgeApi.accessories} recorded
 * through its {@link TestPlatformAccessory.takeWarnings}, and when a line was held or a taken warning is of a failing kind, throw an `AssertionError` quoting
 * each such line and warning.
 *
 * A suite reaches it through {@link watchServerWarnings}, which calls it for every API double the suite built through its builder after each test, once that
 * test's own cleanups have run, so a warning plugin code caught, which the strict throw cannot report, fails the test that drew it. It takes the lines and the
 * warnings before it fails, so one leak fails one test rather than every test after it, and a line a double logs, or a warning an accessory raises, once its
 * test has ended, from a timer, fails the next test's check.
 *
 * An accessory's record holds every warning it raised, registered or not and inside one of the double's calls or outside every call, while the server log holds
 * a warning only as the line Homebridge's printer logs for an accessory it registered or restored, during a call. The failing kinds are `"warn-message"`,
 * `"error-message"`, `"timeout-read"` and `"timeout-write"`, which report a defect in the plugin, such as a value HAP refused or corrected, a handler that threw
 * or a handler that never answered. A slow read or write and a `"debug-message"` warning are taken and pass, because Homebridge treats them as advice: it prints
 * a slow request at info, and not at all for an accessory published outside the bridge, and a debug message only while its debug is on.
 *
 * A test that expects a warning takes it, a line through {@link TestHomebridgeApi.takeServerWarnings} and a characteristic warning through the accessory's
 * {@link TestPlatformAccessory.takeWarnings}. Homebridge's printer logs an `"error-message"` warning at error, so one raised inside a call on an accessory
 * Homebridge registered or restored is held twice, as the API's line and in the accessory's record, and a test that expects it takes the line and the warning.
 * An accessory made outside {@link TestHomebridgeApi.platformAccessory}, from Homebridge's class directly, has no record, so the check cannot see its warnings
 * beyond the error lines Homebridge's printer logs for it during a call.
 *
 * @param api - The API double whose held lines, and whose accessories' recorded warnings, to take.
 *
 * @throws `AssertionError` quoting each warn and error line the API held and each warning of a failing kind its accessories recorded.
 *
 * @example
 *
 * ```ts
 * import { loadHomebridge, watchServerWarnings } from "homebridge-plugin-utils/testing";
 *
 * // Every API double the file builds through setup is handed to assertNoServerWarnings after each test, once that test's own cleanups have run.
 * const setup = watchServerWarnings(await loadHomebridge(import.meta.url));
 * ```
 *
 * @category Testing
 */
export function assertNoServerWarnings(api: TestHomebridgeApi): void {

  // The held lines and every accessory's whole record, advisory warnings included, are taken before anything fails, so one leak fails one test and the next
  // test's check starts clean.
  const held = api.takeServerWarnings();
  const raised = api.accessories.flatMap((accessory) => accessory.takeWarnings().filter(isFailingWarning).map((warning) => ({ accessory, warning })));
  const failures = [

    ...((held.length > 0) ? ["Homebridge's server logged a warning or an error that the test did not take.\n" + quoteServerLines(held)] : []),
    ...((raised.length > 0) ? ["HAP raised a warning or an error on an accessory that the test did not take.\n" + quoteAccessoryWarnings(raised)] : [])
  ];

  if(failures.length > 0) {

    assert.fail(failures.join("\n"));
  }
}

/**
 * Build a `node:test` file's API doubles over a runtime, and after each test check every one of them for a warning Homebridge logged on it, or a warning or an
 * error HAP raised on an accessory it made, that the test left untaken. Called once at the file's top level, it registers one after-each hook and answers the
 * builder the file makes its API doubles through, each over `runtime`.
 *
 * The hook adds the check to the finished test's own cleanups rather than running it itself, because `node:test` runs a file's after-each hooks before a test's
 * own `t.after` cleanups: a check made in the hook would read each double before the test's teardown ran, and a warning plugin code caught during that teardown,
 * such as in a shutdown the teardown emits, would go unchecked. A cleanup added from the hook runs after every cleanup the test registered, its body's late ones
 * included, and fails that test.
 *
 * The check hands every double the builder has made to {@link assertNoServerWarnings}, which takes each one's lines and its accessories' warnings, and only then
 * fails: a lone failure is thrown as it is, and several as one `AggregateError` holding each, so a second leaking double never leaves its lines or warnings for
 * the next test. The aggregate's own message quotes each failure's message, because a reporter that prints only a failure's message, as the TAP reporter does,
 * would otherwise show none of the lines and warnings the aggregate holds. One builder serves a double a test builds for itself and one the file builds once and
 * shares alike, because it holds every double it made until the file ends and checks each after every test, and each double's held set and each accessory's
 * record answer only what was logged or raised since the last check. Holding every double is what makes a late line's report deterministic, where a weakly held
 * one would be reported or not depending on when the garbage collector ran.
 *
 * {@link assertNoServerWarnings} describes what fails the check, and how a test takes the lines and warnings it expects.
 *
 * A file calls it once, at its top level: called inside a `describe`, the hook covers that describe's tests alone, and in a file that calls it twice, the second
 * builder's check, a cleanup of its own, does not run in a test whose first check failed, leaving that builder's lines and warnings to the next test. The check's
 * reach has these edges:
 *
 *   - A line any double the builder made logs, or a warning one of its accessories raises, after its test has ended, from a timer, fails the next test's check,
 *     and one logged or raised after the file's last test goes unchecked.
 *   - `node:test` runs no cleanup after one that throws, so a cleanup that throws leaves its test's lines and warnings to the next test, and so does a cleanup
 *     registered from inside another, which runs after the check.
 *   - The hook runs after a subtest too, so the check runs over the parent test's doubles while the parent is still running, and a line or a warning the parent
 *     has not yet taken fails the subtest.
 *   - A test that leaks and then skips itself or marks itself todo at runtime has its lines and warnings taken and no failure counted, because `node:test`
 *     counts no failure in a skipped or todo test, the check's included.
 *
 * @param runtime - The runtime {@link loadHomebridge} resolved, which every API double the builder makes runs on.
 *
 * @returns A builder that makes an API double over `runtime` and holds it for the check after each test.
 *
 * @example
 *
 * ```ts
 * import { loadHomebridge, watchServerWarnings } from "homebridge-plugin-utils/testing";
 * import { test } from "node:test";
 *
 * // Every API double the file builds through setup is checked after each test, once that test's own cleanups have run.
 * const setup = watchServerWarnings(await loadHomebridge(import.meta.url));
 *
 * test("registers the porch light", () => {
 *
 *   const api = setup();
 *
 *   api.registerPlatformAccessories("homebridge-example", "Example", [new api.platformAccessory("Porch Light", api.hap.uuid.generate("porch-light"))]);
 * });
 * ```
 *
 * @category Testing
 */
export function watchServerWarnings(runtime: HomebridgeRuntime): () => TestHomebridgeApi {

  const apis: TestHomebridgeApi[] = [];

  afterEach((context): void => {

    // The runner hands an after-each hook the context of the test that just finished, which registers cleanups. The hook's type admits a suite's context too.
    assert.ok("after" in context, "An after-each hook runs for a test, whose context registers cleanups.");

    context.after((): void => {

      const failures: unknown[] = [];

      for(const api of apis) {

        try {

          assertNoServerWarnings(api);
        } catch(error) {

          failures.push(error);
        }
      }

      switch(failures.length) {

        case 0: {

          return;
        }

        case 1: {

          throw failures[0];
        }

        // `assertNoServerWarnings` fails only through `assert.fail`, so each failure is an `AssertionError` whose message quotes that double's lines and its
        // accessories' warnings.
        default: {

          throw new AggregateError(failures, "Warnings or errors that the test did not take were left on more than one API double.\n" +
            failures.map((failure) => (failure as Error).message).join("\n"));
        }
      }
    });
  });

  return (): TestHomebridgeApi => {

    const api = new TestHomebridgeApi(runtime);

    apis.push(api);

    return api;
  };
}

/**
 * The refusal a HomeKit controller's read or write request met, as {@link triggerGet} and {@link triggerSet} reject with it: an Error carrying the HAP status
 * HomeKit receives, with a sentence naming the request and the status.
 *
 * HAP's request paths reject with the bare status number, their internal contract with HAP's accessory server. What a suite asserts is the status HomeKit sees,
 * which this error carries as `hapStatus`, the field HAP's own `HapStatusError` carries too and the one {@link hapStatus} reads. A refusal HAP's request path
 * produced carries HAP's own rejection as its `cause`.
 *
 * HAP answers a handler fault, a throw of an error it does not recognize or a value it cannot accept, with `HAPStatus.SERVICE_COMMUNICATION_FAILURE`, the status a
 * deliberate refusal at the default Not Responding status carries too, so the number alone cannot tell a faulted handler from one that refused on purpose.
 * `handlerFault` tells them apart, and {@link hapStatus} fails on a refusal that carries it.
 *
 * @category Testing
 */
export class HomeKitRequestError extends Error {

  /**
   * True when the refusal carries `HAPStatus.SERVICE_COMMUNICATION_FAILURE` and HAP raised a characteristic warning during the request, which is how HAP reports a
   * handler fault: an `"error-message"` warning for a throw of an error it does not recognize, and a `"warn-message"` one for a value it cannot accept. A deliberate
   * refusal raises none of its own and reads false. The reading has these edges:
   *
   *   - The trigger hears every warning on the characteristic while the request runs, so overlapping triggers on one characteristic, or a refusal at that status
   *     after HAP warned about something the handler did (an `updateValue` HAP clamps), read as a fault.
   *   - A read with no get handler whose stored value HAP cannot accept reads as a fault with no handler involved.
   *   - HAP warns, before the handler runs, of a legacy listener it ignores beside a handler of the same kind, a plugin defect, so a refusal beside one reads true at
   *     that status only.
   *   - A legacy listener calling back with an `Error` is the legacy API's way to report a failure, so it reaches HomeKit at that status, unless its message is a
   *     HAP status number, with only a debug line from HAP, and reads as deliberate.
   */
  public readonly handlerFault: boolean;

  /**
   * The HAP status HomeKit receives for the refused request.
   */
  public readonly hapStatus: HAPStatus;

  public override readonly name = "HomeKitRequestError" as const;

  /**
   * Create the refusal of a read or a write request.
   *
   * @param request - The request HomeKit made, a read or a write.
   * @param status  - The HAP status the request was refused with.
   * @param options - The standard error options, whose `cause` carries the rejection HAP's request path produced, and `handlerFault`, true when HAP reported a
   *                  handler fault behind the refusal. It defaults to false, a deliberate refusal.
   */
  public constructor(request: "read" | "write", status: HAPStatus, { handlerFault = false, ...options }: ErrorOptions & { readonly handlerFault?: boolean } = {}) {

    super("HomeKit's " + request + " request was refused with HAP status " + String(status) +
      (handlerFault ? ", because HAP reported a fault while serving it." : "."), options);

    this.handlerFault = handlerFault;
    this.hapStatus = status;
  }
}

/**
 * Read a characteristic the way a HomeKit controller's read request does, through HAP's own read path: HAP refuses a characteristic without the paired-read
 * permission, runs the get handler, and maps a handler's failure to a status: a non-HAP error, or a value HAP cannot accept, becomes
 * `HAPStatus.SERVICE_COMMUNICATION_FAILURE` with a warning, which marks the refusal a {@link HomeKitRequestError.handlerFault | handler fault}. A characteristic
 * without a handler answers its stored value, or the status a stored error left, and a stored value HAP cannot accept is refused the same way, a handler fault
 * with no handler involved.
 *
 * The read goes straight to the characteristic, so it leaves out the refusal HAP's accessory read path makes for the controller before the characteristic sees
 * the read: an admin-only read from a controller without admin rights, refused with `HAPStatus.INSUFFICIENT_PRIVILEGES`.
 *
 * @param characteristic - The characteristic to read.
 *
 * @returns The value HAP answers. A refusal rejects with a {@link HomeKitRequestError} carrying HAP's status, which {@link hapStatus} matches.
 *
 * @category Testing
 */
export async function triggerGet(characteristic: Characteristic): ReturnType<Characteristic["handleGetRequest"]> {

  return await homeKitRequest({ characteristic, request: "read", send: async () => await characteristic.handleGetRequest(CONNECTION) });
}

/**
 * Write a characteristic the way a HomeKit controller's write request does: a characteristic without the paired-write permission is refused with
 * `HAPStatus.READ_ONLY_CHARACTERISTIC`, as HAP's accessory write path refuses it, and any other write goes through HAP's own write path, which validates the value
 * as it validates a controller's, refusing an invalid one with `HAPStatus.INVALID_VALUE_IN_REQUEST`, and runs the set handler. A set handler's non-HAP error
 * becomes `HAPStatus.SERVICE_COMMUNICATION_FAILURE` with a warning, which marks the refusal a {@link HomeKitRequestError.handlerFault | handler fault}.
 *
 * Of the refusals HAP's accessory write path makes for the controller before the characteristic sees the write, the trigger mirrors the paired-write check alone,
 * and leaves out the rest: an admin-only write from a controller without admin rights (`HAPStatus.INSUFFICIENT_PRIVILEGES`), a refusal from the
 * characteristic's own additional-authorization handler (`HAPStatus.INSUFFICIENT_AUTHORIZATION`), and a timed write that was never prepared or whose preparation
 * expired (`HAPStatus.INVALID_VALUE_IN_REQUEST`).
 *
 * @param characteristic - The characteristic to write.
 * @param value          - The value HomeKit writes.
 *
 * @returns The write response HAP answers, if any. A refusal rejects with a {@link HomeKitRequestError} carrying HAP's status, which {@link hapStatus} matches.
 *
 * @category Testing
 */
export async function triggerSet(characteristic: Characteristic, value: CharacteristicValue): ReturnType<Characteristic["handleSetRequest"]> {

  if(!characteristic.props.perms.includes(Perms.PAIRED_WRITE)) {

    throw new HomeKitRequestError("write", HAPStatus.READ_ONLY_CHARACTERISTIC);
  }

  return await homeKitRequest({ characteristic, request: "write", send: async () => await characteristic.handleSetRequest(value, CONNECTION) });
}

/* Run one of HAP's request paths on a characteristic and turn its rejection into the error a suite meets: HAP's numeric status becomes a HomeKitRequestError
 * naming the request, with HAP's rejection as its cause. Anything else passes through unchanged: a rejection that is not a number, and a number HBPU's mirror of
 * HAP's statuses lacks. HAP rejects only with statuses its own enum holds, so only a HAP copy newer than the mirror produces such a number, and it reaches the
 * suite as HAP produced it rather than as a status the mirror cannot name.
 *
 * HAP refuses a request for a handler fault with SERVICE_COMMUNICATION_FAILURE and reports the fault only through a warning on the characteristic, raised before
 * the request's promise settles: an "error-message" warning for a handler's throw of an error HAP does not recognize, and a "warn-message" one for a value HAP
 * cannot accept. A deliberate refusal raises none of its own, so a listener on the characteristic for the span of this request alone hears what tells a fault from
 * a deliberate refusal at the same status. It hears every warning raised there in that span, though, so a warning the refusal did not cause, an overlapping
 * trigger's, one HAP raised about something the handler did, or HAP's notice of a legacy listener it ignores beside the handler, marks the refusal a fault too;
 * HomeKitRequestError's handlerFault states each edge. Any warning counts, whatever its type or wording, so the reading never depends on how HAP phrases a fault.
 * The listener comes off however the request ends, so a characteristic carries none between requests.
 */
async function homeKitRequest<T>({ characteristic, request, send }: { characteristic: Characteristic; request: "read" | "write"; send: () => Promise<T> }): Promise<T> {

  let warned = false;

  const hearWarning = (): void => {

    warned = true;
  };

  characteristic.on(CHARACTERISTIC_WARNING, hearWarning);

  try {

    return await send();
  } catch(rejection) {

    const status = (typeof rejection === "number") ? HAP_STATUSES.get(rejection) : undefined;

    throw (status === undefined) ? rejection :
      new HomeKitRequestError(request, status, { cause: rejection, handlerFault: (status === HAPStatus.SERVICE_COMMUNICATION_FAILURE) && warned });
  } finally {

    characteristic.off(CHARACTERISTIC_WARNING, hearWarning);
  }
}

/**
 * Build a validation function for `assert.rejects` or `assert.throws` that asserts the rejection is an Error carrying the given HAP status as its `hapStatus`, and
 * returns true. It reads the {@link HomeKitRequestError} that {@link triggerGet} and {@link triggerSet} reject with and the `HapStatusError` a wrapped handler
 * called directly throws alike, because each carries the status in that field.
 *
 * A refusal marked a {@link HomeKitRequestError.handlerFault | handler fault} fails before its status is compared, because a faulted handler reaches HomeKit with
 * the same status a deliberate Not Responding refusal carries, and passing it would let a fault stand in for the refusal a suite asserts.
 *
 * @param status - The status the rejection must carry.
 *
 * @returns A validation function that asserts the rejection is a deliberate refusal carrying `status` and returns true.
 *
 * @example
 *
 * ```ts
 * await assert.rejects(triggerGet(characteristic), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE));
 * ```
 *
 * @category Testing
 */
export function hapStatus(status: HAPStatus): (rejection: unknown) => boolean {

  return (rejection: unknown): boolean => {

    assert.ok((rejection instanceof Error) && ("hapStatus" in rejection), "The rejection must be an Error carrying a HAP status.");
    assert.ok(!((rejection instanceof HomeKitRequestError) && rejection.handlerFault),
      "HAP reported a handler fault rather than a deliberate refusal with a HAP status.");
    assert.equal(rejection.hapStatus, status);

    return true;
  };
}

// HAP's handler fields, which its declaration marks private and its request paths read at runtime: the handlers a characteristic's onGet and onSet installed.
interface CharacteristicHandlers {

  readonly getHandler?: unknown;
  readonly setHandler?: unknown;
}

/**
 * Answer whether HAP's read path has plugin code to call on a characteristic: an `onGet` handler, or, without one, a legacy `get` listener, which HAP's read path
 * falls back to.
 *
 * HAP keeps the `onGet` handler in its `getHandler` field, which its declaration marks private, so one kit function reads the field rather than each suite reaching
 * into HAP itself, and a HAP release that renames it fails HBPU's own suite rather than a sibling's silently. A read HAP refuses before it reaches plugin code, of
 * a characteristic without the paired-read permission, is {@link triggerGet}'s to report.
 *
 * @param characteristic - The characteristic to inspect.
 *
 * @returns True when the characteristic carries an `onGet` handler or a legacy `get` listener.
 *
 * @category Testing
 */
export function hasGetHandler(characteristic: Characteristic): boolean {

  return ((characteristic as unknown as CharacteristicHandlers).getHandler !== undefined) || (characteristic.listenerCount(CHARACTERISTIC_GET) > 0);
}

/**
 * Answer whether HAP's write path has plugin code to call on a characteristic: an `onSet` handler, or, without one, a legacy `set` listener, which HAP's write path
 * falls back to.
 *
 * HAP keeps the `onSet` handler in its `setHandler` field, which its declaration marks private, so one kit function reads the field rather than each suite reaching
 * into HAP itself, and a HAP release that renames it fails HBPU's own suite rather than a sibling's silently. A write refused before it reaches plugin code, of a
 * characteristic without the paired-write permission or of an invalid value, is {@link triggerSet}'s to report.
 *
 * @param characteristic - The characteristic to inspect.
 *
 * @returns True when the characteristic carries an `onSet` handler or a legacy `set` listener.
 *
 * @category Testing
 */
export function hasSetHandler(characteristic: Characteristic): boolean {

  return ((characteristic as unknown as CharacteristicHandlers).setHandler !== undefined) || (characteristic.listenerCount(CHARACTERISTIC_SET) > 0);
}
