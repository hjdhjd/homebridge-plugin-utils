/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * homebridge-double.test.ts: Unit tests for the Homebridge test double - the loader's resolution of Homebridge's own hap-nodejs copy and classes and its failure
 * sentences, the API double's calls through Homebridge's own API and bridge service with their call record, restore, server log, strict throw, and the held set
 * with its check, which takes every accessory's warnings too, the change and warning record on every accessory it makes with its take, HomeKit's read and write
 * paths with the refusal error they reject with and its mark of a handler fault, the status matcher, the handler accessors, and, in child processes, the builder
 * that checks every API double it made after each test's own cleanups, read from a test run of the child's own, the testing entry point that loads neither
 * Homebridge nor HAP and registers no exit listener, the first API double a process builds, whose construction warning throws with nothing printed, and a process
 * that exits on its own, leaving no temporary cache folder.
 */
import { CharacteristicWarningType, HAPStatus } from "../homebridge-enums.ts";
import type { Controller, DynamicPlatformPlugin, PlatformAccessory } from "homebridge";
import { HomeKitRequestError, HomebridgeServerWarning, TestHomebridgeApi, assertNoServerWarnings, hapStatus, hasGetHandler, hasSetHandler, loadHomebridge,
  triggerGet, triggerSet, watchServerWarnings } from "./homebridge-double.ts";
import { assertNoUnhandledRejections, expectAt, makeScratchRoot } from "./index.ts";
import { describe, test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import type { TestContext } from "node:test";
import type { TestPlatformAccessory } from "./homebridge-double.ts";
import { armDeadline } from "../clock.ts";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

// The runtime every row runs on, resolved from this repository's own tree.
const runtime = await loadHomebridge(import.meta.url);
const { hap } = runtime;

// The plugin identifier and platform name the rows hand the accessory calls.
const PLUGIN = "homebridge-test";
const PLATFORM = "TestPlatform";

// The sentence hapStatus fails with on a refusal marked a handler fault.
const FAULT_SENTENCE = "HAP reported a handler fault rather than a deliberate refusal with a HAP status.";

// What Homebridge's bridge service logs as it skips a duplicate registration, and the error lines it logs when a save fails, which a row's throw quotes.
const SKIPPING_DUPLICATE = "Skipping duplicate.";
const SAVE_FAILED = "Failed to save cached accessories to disk: ";
const SAVE_NOT_PERSISTED = "Your accessories will not persist between restarts until this issue is resolved.";

// The testing entry point and the test loader, which a child process imports by URL.
const INDEX_URL = new URL("./index.ts", import.meta.url).href;
const TEST_LOADER_URL = new URL("../../ui/test-loader.mjs", import.meta.url).href;

// Homebridge's logger module, imported from Homebridge's directory as the loader imports Homebridge's classes, by the rows that reach its debug switch or its colors.
const LOGGER_URL = pathToFileURL(join(dirname(createRequire(import.meta.url).resolve("homebridge")), "logger.js")).href;

// How long a child process may take to reach its own exit before its spawn's deadline kills it. Generous enough for a cold type-stripping start on a slow CI host,
// and short enough that the kill lands well inside the runner's own per-test timeout.
const CHILD_EXIT_BOUND_MS = 10000;

// The prefix every row's scratch folder is named with, so a folder a killed run leaves behind names this suite.
const SCRATCH_PREFIX = "hbpu-homebridge-double-";

// A fake Homebridge package, its entry point present for resolution alone, and a fake hap-nodejs Homebridge requires, for the loader's failure rows.
const FAKE_HOMEBRIDGE = {

  "node_modules/homebridge/dist/index.js": "export {};\n",
  "node_modules/homebridge/package.json": JSON.stringify({ main: "dist/index.js", name: "homebridge", type: "module" })
};

const FAKE_HAP = {

  "node_modules/homebridge/node_modules/@homebridge/hap-nodejs/index.js": "module.exports = {};\n",
  "node_modules/homebridge/node_modules/@homebridge/hap-nodejs/package.json": JSON.stringify({ main: "index.js", name: "@homebridge/hap-nodejs" })
};

// What a child process answered: its exit code, null when the spawn's deadline killed it, beside everything it wrote.
interface ChildOutcome {

  readonly code: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

// A fresh API double over the suite's runtime, the one every row builds its accessories through, each checked for untaken warnings after every row once the
// row's own cleanups have run, the check every suite using the double makes.
const setup = watchServerWarnings(runtime);

// An accessory made through the API, named as given and carrying a UUID generated from that name, so rows that need a matching UUID name it.
function accessoryNamed(api: TestHomebridgeApi, name: string): TestPlatformAccessory {

  return new api.platformAccessory(name, hap.uuid.generate("homebridge-plugin-utils.homebridge-double-test." + name));
}

// A platform whose configureAccessory records the name of each accessory Homebridge hands it, in the order it hands them over.
function recordingPlatform(seen: string[]): Pick<DynamicPlatformPlugin, "configureAccessory"> {

  return {

    configureAccessory: (accessory: PlatformAccessory): void => {

      seen.push(accessory.displayName);
    }
  };
}

// Restore a lamp whose configureAccessory writes a brightness past its maximum, which HAP clamps with a "warn-message" warning that Homebridge's printer logs at
// info, with the warning's stack at debug while Homebridge's debug is on, then make the same write once the restore has returned, outside every call.
function restoreClamped(api: TestHomebridgeApi): TestPlatformAccessory {

  const lamp = accessoryNamed(api, "Lamp");
  const brightness = lamp.addService(hap.Service.Lightbulb, "Lamp Bulb").getCharacteristic(hap.Characteristic.Brightness);

  const platform = {

    configureAccessory: (): void => {

      brightness.updateValue(500);
    }
  };

  api.restorePlatformAccessories({ accessories: [lamp], platform, platformName: PLATFORM, pluginIdentifier: PLUGIN });
  brightness.updateValue(600);

  return lamp;
}

// The kinds restoreClamped's writes leave in the lamp's record, a "warn-message" clamp for each, which a row taking that record asserts.
const RESTORE_CLAMPED_KINDS = [ CharacteristicWarningType.WARN_MESSAGE, CharacteristicWarningType.WARN_MESSAGE ];

// Turn Homebridge's debug lines on for the rest of the row, and back to what they were once it ends. Homebridge's declaration of its Logger class keeps the switch
// off the runtime's type, so the helper reaches it on Homebridge's own logger module, whose class the runtime carries.
async function homebridgeDebugOn(t: TestContext): Promise<void> {

  const { Logger } = await import(LOGGER_URL) as { Logger: { setDebugEnabled: (enabled: boolean) => void } };
  const { debugEnabled } = runtime.Logger;

  t.after(() => Logger.setDebugEnabled(debugEnabled));
  Logger.setDebugEnabled(true);
}

// Replace the console's log, warning and error writers with silent mocks for the row, answering how many times anything reached for them: HAP prints a warning no
// listener hears through them and Homebridge's logger prints each of its lines through them, so a captured warning and a server line must keep the count at zero.
function consoleWrites(t: TestContext): () => number {

  const log = t.mock.method(console, "log", (): void => undefined);
  const warn = t.mock.method(console, "warn", (): void => undefined);
  const error = t.mock.method(console, "error", (): void => undefined);

  return (): number => log.mock.callCount() + warn.mock.callCount() + error.mock.callCount();
}

/* A validation function for assert.throws asserting the failure is a HomebridgeServerWarning carrying one line for each quote, in order, each line's message
 * holding its quote and the error's message quoting the line. It then takes the lines the API whose call logged them holds, which must be the very lines the
 * warning carries, so a row that expects Homebridge to warn takes what it expected. A construction that throws leaves no API to hold its lines, so its rows pass
 * null.
 */
function warnedWith(api: TestHomebridgeApi | null, ...quotes: string[]): (error: unknown) => boolean {

  return (error: unknown): boolean => {

    assert.ok(error instanceof HomebridgeServerWarning, "the call must throw Homebridge's warning");
    assert.equal(error.name, "HomebridgeServerWarning");
    assert.equal(error.lines.length, quotes.length, "the warning must carry each line Homebridge logged at warn or error level, and only those: " + error.message);

    for(const [ index, quote ] of quotes.entries()) {

      const line: string = expectAt(error.lines, index).message;

      assert.ok(line.includes(quote), "each line must be the one Homebridge logged: " + line);
      assert.ok(error.message.includes(line), "and the error's message must quote it");
    }

    if(api) {

      assert.deepEqual(api.takeServerWarnings(), error.lines, "the API whose call logged the lines must hold exactly the lines the warning carries");
    }

    return true;
  };
}

// A validation function for assert.rejects asserting the rejection is a HomeKitRequestError carrying the status, sentence and cause given, the cause absent for a
// refusal the trigger makes itself, and marked a handler fault exactly when HAP reported one behind the refusal.
function refusedWith({ cause, handlerFault = false, message, status }: { cause?: HAPStatus; handlerFault?: boolean; message: string; status: HAPStatus }):
(rejection: unknown) => boolean {

  return (rejection: unknown): boolean => {

    assert.ok(rejection instanceof HomeKitRequestError, "a trigger's refusal must be a HomeKitRequestError");
    assert.equal(rejection.name, "HomeKitRequestError");
    assert.equal(rejection.hapStatus, status);
    assert.equal(rejection.message, message);
    assert.equal(rejection.cause, cause, "a refusal HAP's request path produced carries HAP's own rejection as its cause, and the trigger's own carries none");
    assert.equal(rejection.handlerFault, handlerFault, "a refusal is a handler fault exactly when HAP reported one behind it");

    return true;
  };
}

// Write each file under the scratch root, its directories created as needed.
async function writeTree(root: string, files: Record<string, string>): Promise<void> {

  await Promise.all(Object.entries(files).map(async ([ path, contents ]) => {

    const target = join(root, path);

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
  }));
}

/**
 * Run an ES module source as a child Node process through the test loader, answering its exit code and everything it wrote. What the child rows read cannot be read
 * from inside this suite: the runner has already loaded HAP for every other row, and it holds the event loop open on its own account, so a child is the smallest
 * arrangement that shows what the rows assert.
 *
 * The child carries a type-stripping flag beside the loader, and nothing else of the runner's, when the runner carries one, so it can import the testing entry
 * point's .ts source; never the --test or coverage flags, which would derail it into a second test run over files of its own. The flags a row hands it go
 * beside them, such as the reporter a child that declares tests of its own reports in. The spawn is bounded by a deadline, so a child that fails to reach its own
 * exit is killed there and answers a null code, which fails the row's assertion rather than hanging the suite.
 *
 * @param options        - The child's options.
 * @param options.args   - Flags the child carries before its source, such as a test reporter. Defaults to none.
 * @param options.env    - Variables the child's environment carries beside the runner's own, such as a temp folder of the row's. Defaults to none.
 * @param options.source - The child's ES module source.
 *
 * @returns The child's exit code, or null when the deadline killed it, beside its stdout and stderr.
 */
async function runChild({ args = [], env = {}, source }: { args?: readonly string[]; env?: Record<string, string>; source: string }): Promise<ChildOutcome> {

  const stripFlag = process.execArgv.find((arg) => (arg === "--strip-types") || (arg === "--experimental-strip-types"));
  const childArgs = [ ...(stripFlag ? [stripFlag] : []), "--import", TEST_LOADER_URL, ...args, "--input-type=module", "--eval", source ];

  using deadline = armDeadline(CHILD_EXIT_BOUND_MS);

  return await new Promise<ChildOutcome>((resolveOutcome) => {

    const stderrChunks: Buffer[] = [];
    const stdoutChunks: Buffer[] = [];
    const child = spawn(process.execPath, childArgs, { env: { ...process.env, ...env }, signal: deadline.signal, stdio: [ "ignore", "pipe", "pipe" ] });

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    // A child killed at the deadline surfaces here as an error rather than as a clean close, so this listener is what turns a hung child into a failed assertion.
    child.on("error", (error: Error) => resolveOutcome({ code: null, stderr: error.message, stdout: "" }));
    child.on("close", (code) => resolveOutcome({ code, stderr: Buffer.concat(stderrChunks).toString("utf8"), stdout: Buffer.concat(stdoutChunks).toString("utf8") }));
  });
}

// One fixture test's outcome in a child's test run: whether it passed, and the TAP the child wrote for it, which carries a failure's message and error name.
interface FixtureOutcome {

  readonly passed: boolean;
  readonly report: string;
}

/* Run fixture tests in a test run of a child's own and answer each top-level test's outcome, in order, beside everything the child wrote. A row watches a test
 * fail the warnings check from here, because a fixture test failing it in this suite would fail the suite. The child clears the runner's context, which would
 * have it report in the runner's own protocol, and reports in TAP, so a row reads every fixture test's outcome rather than the exit code, which reads 1 whichever
 * test failed. Each fixture builds its API doubles through `build`, a builder the child makes over its own runtime, and `swallow` is plugin code that registers
 * an accessory of the given name twice and catches the strict throw, leaving Homebridge's duplicate skip, which names the accessory, held on the double.
 */
async function runFixtureTests(...lines: string[]): Promise<{ outcomes: FixtureOutcome[]; output: string }> {

  const { stderr, stdout } = await runChild({ args: ["--test-reporter=tap"], env: { NODE_TEST_CONTEXT: "" }, source: [

    "import { test } from 'node:test';",
    "const kit = await import(" + JSON.stringify(INDEX_URL) + ");",
    "const build = kit.watchServerWarnings(await kit.loadHomebridge(" + JSON.stringify(INDEX_URL) + "));",
    "const swallow = (api, name) => {",
    "  const accessory = new api.platformAccessory(name, api.hap.uuid.generate('fixture.' + name));",
    "  api.registerPlatformAccessories('homebridge-test', 'TestPlatform', [accessory]);",
    "  try { api.registerPlatformAccessories('homebridge-test', 'TestPlatform', [accessory]); } catch { }",
    "};",
    ...lines
  ].join("\n") });

  // A top-level test's report opens with its subtest comment at the start of a line, and its verdict line sits at the start of a line too, where a nested one
  // is indented.
  return { outcomes: stdout.split(/^# Subtest: /mu).slice(1).map((report) => ({ passed: /^ok \d+ - /mu.test(report), report })), output: stdout + stderr };
}

// Whether each fixture test passed, in order.
function verdicts(outcomes: readonly FixtureOutcome[]): boolean[] {

  return outcomes.map(({ passed }) => passed);
}

describe("loadHomebridge", () => {

  test("answers the hap-nodejs copy Homebridge requires and Homebridge's own PlatformAccessory class running over it", async () => {

    // The oracle resolves Homebridge from this file and requires hap-nodejs from Homebridge's entry point, which is the copy Homebridge's own modules load. The
    // repository's top-level hap-nodejs can be another copy entirely, which is the split the loader exists to see through.
    const entry = createRequire(import.meta.url).resolve("homebridge");
    const homebridgeHap = createRequire(entry)("@homebridge/hap-nodejs") as typeof hap;
    const homebridgeModule = await import(pathToFileURL(join(dirname(entry), "platformAccessory.js")).href) as { PlatformAccessory: unknown };

    assert.equal(runtime.hap, homebridgeHap, "the namespace must be the very module Homebridge requires");
    assert.equal(runtime.hap.HAPLibraryVersion(), homebridgeHap.HAPLibraryVersion(), "and so must carry the version Homebridge runs");
    assert.equal(runtime.PlatformAccessory, homebridgeModule.PlatformAccessory, "the class must be the one Homebridge's own module exports");

    const accessory = new runtime.PlatformAccessory("Probe", hap.uuid.generate("homebridge-plugin-utils.homebridge-double-test.probe"));

    assert.ok(accessory._associatedHAPAccessory instanceof runtime.hap.Accessory, "the class must build its accessories on the same HAP the namespace is");

    const fromUrl = await loadHomebridge(new URL(import.meta.url));
    const fromPath = await loadHomebridge(fileURLToPath(import.meta.url));

    assert.equal(fromUrl.hap, runtime.hap, "a URL object must resolve the same tree as a URL string");
    assert.equal(fromPath.PlatformAccessory, runtime.PlatformAccessory, "and so must an absolute file path");
  });

  test("answers Homebridge's own HomebridgeAPI, BridgeService and Logger classes, each the export of Homebridge's own module", async () => {

    const entry = createRequire(import.meta.url).resolve("homebridge");
    // What one of Homebridge's modules exports, imported from Homebridge's directory as the oracle imports PlatformAccessory's.
    const exported = async (file: string): Promise<Record<string, unknown>> => {

      return await import(pathToFileURL(join(dirname(entry), file)).href) as Record<string, unknown>;
    };

    assert.equal(runtime.HomebridgeAPI, (await exported("api.js"))["HomebridgeAPI"], "the API class must be the one Homebridge's own module exports");
    assert.equal(runtime.BridgeService, (await exported("bridgeService.js"))["BridgeService"], "and so must the bridge service");
    assert.equal(runtime.Logger, (await exported("logger.js"))["Logger"], "and the logger");
  });

  test("rejects with a sentence naming the package and where it looked when Homebridge cannot be resolved", async () => {

    await using root = await makeScratchRoot(SCRATCH_PREFIX);
    const probe = pathToFileURL(join(root.path, "probe.mjs"));

    await assert.rejects(loadHomebridge(probe), (error: unknown) => {

      assert.ok(error instanceof Error);
      assert.equal(error.message, "The homebridge package could not be resolved from " + probe.href + ".");
      assert.equal((error.cause as { code?: unknown } | undefined)?.code, "MODULE_NOT_FOUND", "the resolution failure must travel as the cause");

      return true;
    });
  });

  test("rejects with a sentence naming Homebridge's entry point when hap-nodejs cannot be required from it", async () => {

    await using root = await makeScratchRoot(SCRATCH_PREFIX);

    await writeTree(root.path, FAKE_HOMEBRIDGE);

    const entry = join(await realpath(root.path), "node_modules", "homebridge", "dist", "index.js");

    await assert.rejects(loadHomebridge(pathToFileURL(join(root.path, "probe.mjs"))), (error: unknown) => {

      assert.ok(error instanceof Error);
      assert.equal(error.message, "The hap-nodejs package could not be required from Homebridge's entry point at " + entry + ".");
      assert.equal((error.cause as { code?: unknown } | undefined)?.code, "MODULE_NOT_FOUND", "the require failure must travel as the cause");

      return true;
    });
  });

  test("rejects with a sentence naming the module when Homebridge's platformAccessory.js cannot be imported", async () => {

    await using root = await makeScratchRoot(SCRATCH_PREFIX);

    await writeTree(root.path, { ...FAKE_HOMEBRIDGE, ...FAKE_HAP });

    const moduleUrl = pathToFileURL(join(await realpath(root.path), "node_modules", "homebridge", "dist", "platformAccessory.js")).href;

    await assert.rejects(loadHomebridge(pathToFileURL(join(root.path, "probe.mjs"))), (error: unknown) => {

      assert.ok(error instanceof Error);
      assert.equal(error.message, "Homebridge's PlatformAccessory module could not be imported from " + moduleUrl + ".");
      assert.equal((error.cause as { code?: unknown } | undefined)?.code, "ERR_MODULE_NOT_FOUND", "the import failure must travel as the cause");

      return true;
    });
  });

  test("rejects with a sentence naming the module when it loads without a PlatformAccessory class among its exports", async () => {

    await using root = await makeScratchRoot(SCRATCH_PREFIX);

    await writeTree(root.path, { ...FAKE_HOMEBRIDGE, ...FAKE_HAP, "node_modules/homebridge/dist/platformAccessory.js": "export const PlatformAccessoryEvent = {};\n" });

    const moduleUrl = pathToFileURL(join(await realpath(root.path), "node_modules", "homebridge", "dist", "platformAccessory.js")).href;

    await assert.rejects(loadHomebridge(pathToFileURL(join(root.path, "probe.mjs"))), {

      message: "Homebridge's module at " + moduleUrl + " does not export the PlatformAccessory class."
    });
  });

  test("rejects with a sentence naming the module when one of Homebridge's server modules loads without its class among its exports", async () => {

    await using root = await makeScratchRoot(SCRATCH_PREFIX);

    await writeTree(root.path, { ...FAKE_HOMEBRIDGE, ...FAKE_HAP, "node_modules/homebridge/dist/api.js": "export class HomebridgeAPI {}\n",
      "node_modules/homebridge/dist/bridgeService.js": "export const DEFAULT_BRIDGE_DEFAULTS = {};\n",
      "node_modules/homebridge/dist/platformAccessory.js": "export class PlatformAccessory {}\n" });

    const moduleUrl = pathToFileURL(join(await realpath(root.path), "node_modules", "homebridge", "dist", "bridgeService.js")).href;

    await assert.rejects(loadHomebridge(pathToFileURL(join(root.path, "probe.mjs"))), {

      message: "Homebridge's module at " + moduleUrl + " does not export the BridgeService class."
    });
  });
});

describe("TestHomebridgeApi - accessory calls", () => {

  test("register refuses an accessory that is not a PlatformAccessory with a TypeError before recording, the accessories ahead of it already stamped", () => {

    const api = setup();
    const lamp = accessoryNamed(api, "Lamp");
    const bare = new hap.Accessory("Bare", hap.uuid.generate("homebridge-plugin-utils.homebridge-double-test.bare")) as unknown as PlatformAccessory;

    assert.throws(() => api.registerPlatformAccessories(PLUGIN, PLATFORM, [ lamp, bare ]), {

      message: "homebridge-test - TestPlatform attempt to register an accessory that isn't PlatformAccessory!",
      name: "TypeError"
    });

    assert.equal(lamp._associatedPlugin, PLUGIN, "Homebridge stamps each accessory as it checks it, so the one ahead of the refusal carries the stamp");
    assert.deepEqual(api.calls, [], "a refused call must record nothing");
    assert.equal(lamp._associatedHAPAccessory.bridged, false, "and must bridge nothing");
  });

  test("unregister and publish refuse an accessory that is not a PlatformAccessory with a TypeError before recording", () => {

    const api = setup();
    const bare = new hap.Accessory("Bare", hap.uuid.generate("homebridge-plugin-utils.homebridge-double-test.bare")) as unknown as PlatformAccessory;

    assert.throws(() => api.unregisterPlatformAccessories(PLUGIN, PLATFORM, [bare]), {

      message: "homebridge-test - TestPlatform attempt to unregister an accessory that isn't PlatformAccessory!",
      name: "TypeError"
    });

    // Homebridge's publish refuses with the sentence its registration uses, naming no platform.
    assert.throws(() => api.publishExternalAccessories(PLUGIN, [bare]), {

      message: "homebridge-test attempt to register an accessory that isn't PlatformAccessory!",
      name: "TypeError"
    });

    assert.deepEqual(api.calls, [], "a refused call must record nothing");
  });

  test("register stamps the plugin and platform, records a copy of what it was handed, and caches and bridges each accessory", () => {

    const api = setup();
    const lamp = accessoryNamed(api, "Lamp");
    const fan = accessoryNamed(api, "Fan");
    const handed = [ lamp, fan ];

    api.registerPlatformAccessories(PLUGIN, PLATFORM, handed);
    handed.length = 0;

    assert.deepEqual(api.calls, [{ accessories: [ lamp, fan ], kind: "register", platformName: PLATFORM, pluginIdentifier: PLUGIN }],
      "the record must hold a copy of the accessories, untouched by a later edit of the array the plugin handed over");
    assert.equal(lamp._associatedPlugin, PLUGIN);
    assert.equal(lamp._associatedPlatform, PLATFORM);
    assert.equal(lamp._associatedHAPAccessory.bridged, true, "a registered accessory must be on the bridge");
    assert.equal(fan._associatedHAPAccessory.bridged, true);
  });

  test("register skips an accessory whose UUID is already cached, leaving it off the bridge and recording the call, and bridges the rest", () => {

    const api = setup();
    const lamp = accessoryNamed(api, "Lamp");
    const duplicate = new api.platformAccessory("Lamp Copy", lamp.UUID);
    const fan = accessoryNamed(api, "Fan");

    api.registerPlatformAccessories(PLUGIN, PLATFORM, [lamp]);

    assert.throws(() => api.registerPlatformAccessories(PLUGIN, PLATFORM, [ duplicate, fan ]), warnedWith(api, SKIPPING_DUPLICATE));
    assert.equal(duplicate._associatedHAPAccessory.bridged, false, "a duplicate UUID must stay off the bridge");
    assert.equal(duplicate._associatedPlugin, PLUGIN, "Homebridge's API stamps the duplicate before its server skips it");
    assert.equal(fan._associatedHAPAccessory.bridged, true, "the rest of the call must proceed");
    assert.deepEqual(api.calls.map((call) => call.accessories), [ [lamp], [ duplicate, fan ] ], "the call carrying the duplicate is recorded as made");
  });

  test("register past the bridge's accessory limit reaches the caller with HAP's refusal and no call recorded", () => {

    // HAP's bridge refuses an accessory once it holds its limit, the refusal Homebridge's server lets reach the plugin, so the call that carried it never counts.
    const api = setup();
    const accessories = Array.from({ length: 150 }, (_, index) => accessoryNamed(api, "Lamp " + String(index)));

    assert.throws(() => api.registerPlatformAccessories(PLUGIN, PLATFORM, accessories), /Cannot Bridge more than \d+ Accessories/);
    assert.deepEqual(api.calls.map(({ kind }) => kind), [], "a call HAP refuses at the bridge adds no entry");
  });

  test("register skips an accessory whose UUID is still on the bridge after its cache entry is gone", () => {

    // The cache entry goes the way Homebridge's server lets it: an update puts a new object under the UUID, and an unregister of that object takes it out of the
    // cache before HAP refuses to remove it from a bridge it was never on. The original stays bridged with nothing cached under its UUID. The new object was never
    // registered, so Homebridge's save cannot write it and the update throws, until the unregister takes it out of the cache.
    const api = setup();
    const lamp = accessoryNamed(api, "Lamp");
    const replacement = new api.platformAccessory("Lamp", lamp.UUID);
    const late = new api.platformAccessory("Lamp", lamp.UUID);

    api.registerPlatformAccessories(PLUGIN, PLATFORM, [lamp]);

    assert.throws(() => api.updatePlatformAccessories([replacement]), warnedWith(api, SAVE_FAILED, SAVE_NOT_PERSISTED));
    assert.throws(() => api.unregisterPlatformAccessories(PLUGIN, PLATFORM, [replacement]), /Cannot find the bridged Accessory to remove/);
    assert.throws(() => api.registerPlatformAccessories(PLUGIN, PLATFORM, [late]), warnedWith(api, "same UUID as existing bridged accessory"));
    assert.equal(late._associatedHAPAccessory.bridged, false, "a UUID the bridge holds must be skipped even with no cache entry");
    assert.equal(lamp._associatedHAPAccessory.bridged, true, "the accessory holding the UUID must stay bridged");
  });

  test("update caches an accessory never registered and puts each accessory it is handed in place of the cached one sharing its UUID", () => {

    // The fan was never registered, so it carries no stamp Homebridge's save can write, and every call that saves while it stays cached fails and throws, as each
    // such save fails under Homebridge. The row reads what each call leaves in the cache.
    const api = setup();
    const fan = accessoryNamed(api, "Fan");
    const fanCopy = new api.platformAccessory("Fan", fan.UUID);

    assert.throws(() => api.updatePlatformAccessories([fan]), warnedWith(api, SAVE_FAILED, SAVE_NOT_PERSISTED));
    assert.deepEqual(api.calls, [{ accessories: [fan], kind: "update" }]);
    assert.throws(() => api.registerPlatformAccessories(PLUGIN, PLATFORM, [fanCopy]), warnedWith(api, SKIPPING_DUPLICATE, SAVE_FAILED, SAVE_NOT_PERSISTED));
    assert.equal(fanCopy._associatedHAPAccessory.bridged, false, "an update caches what it is handed, registered or not, so a later registration is a duplicate");

    // A cache that kept the first object beside its successor would still hold the UUID once the successor left it, and the final registration would be skipped.
    const lamp = accessoryNamed(api, "Lamp");
    const successor = new api.platformAccessory("Lamp", lamp.UUID);
    const fresh = new api.platformAccessory("Lamp", lamp.UUID);

    assert.throws(() => api.updatePlatformAccessories([lamp]), warnedWith(api, SAVE_FAILED, SAVE_NOT_PERSISTED));
    assert.throws(() => api.updatePlatformAccessories([successor]), warnedWith(api, SAVE_FAILED, SAVE_NOT_PERSISTED));
    assert.throws(() => api.unregisterPlatformAccessories(PLUGIN, PLATFORM, [successor]), /Cannot find the bridged Accessory to remove/);
    assert.throws(() => api.registerPlatformAccessories(PLUGIN, PLATFORM, [fresh]), warnedWith(api, SAVE_FAILED, SAVE_NOT_PERSISTED));
    assert.equal(fresh._associatedHAPAccessory.bridged, true, "the successor must have taken the first object's place in the cache rather than joining it");
  });

  test("unregister removes a cached accessory by identity, so another accessory sharing its UUID leaves the cached one in place", () => {

    // The lamp was never registered, so Homebridge's save cannot write it, and each call that saves while it is cached throws.
    const api = setup();
    const lamp = accessoryNamed(api, "Lamp");
    const stranger = new api.platformAccessory("Lamp", lamp.UUID);
    const late = new api.platformAccessory("Lamp", lamp.UUID);

    assert.throws(() => api.updatePlatformAccessories([lamp]), warnedWith(api, SAVE_FAILED, SAVE_NOT_PERSISTED));
    assert.throws(() => api.unregisterPlatformAccessories(PLUGIN, PLATFORM, [stranger]), /Cannot find the bridged Accessory to remove/);
    assert.throws(() => api.registerPlatformAccessories(PLUGIN, PLATFORM, [late]), warnedWith(api, SKIPPING_DUPLICATE, SAVE_FAILED, SAVE_NOT_PERSISTED));
    assert.equal(late._associatedHAPAccessory.bridged, false, "the cached accessory must survive an unregister of a different object with its UUID");
  });

  test("unregister takes each accessory off the bridge, and HAP's refusal of one the bridge does not hold reaches the caller with no call recorded", () => {

    const api = setup();
    const lamp = accessoryNamed(api, "Lamp");
    const stranger = accessoryNamed(api, "Stranger");

    api.registerPlatformAccessories(PLUGIN, PLATFORM, [lamp]);
    api.unregisterPlatformAccessories(PLUGIN, PLATFORM, [lamp]);

    assert.equal(lamp._associatedHAPAccessory.bridged, false, "an unregistered accessory must leave the bridge");
    assert.deepEqual(api.calls.map(({ kind }) => kind), [ "register", "unregister" ], "an unregister the bridge accepted adds one entry");

    api.registerPlatformAccessories(PLUGIN, PLATFORM, [lamp]);

    assert.equal(lamp._associatedHAPAccessory.bridged, true, "and must leave the cache, so registering it again bridges it again");

    assert.throws(() => api.unregisterPlatformAccessories(PLUGIN, PLATFORM, [stranger]), { message: "Cannot find the bridged Accessory to remove." });
    assert.deepEqual(api.calls.map(({ kind }) => kind), [ "register", "unregister", "register" ],
      "a call HAP refuses at the bridge adds no entry, so a suite counting the calls counts only those Homebridge accepted");
  });

  test("publish stamps the plugin, records the call, and leaves the accessory unbridged and uncached", async () => {

    const api = setup();
    const doorbell = accessoryNamed(api, "Doorbell");

    // Homebridge's bridge service publishes asynchronously, asking its external port service for a port first, so a publish that reached it would reject once
    // this call returned.
    await assertNoUnhandledRejections(async () => {

      api.publishExternalAccessories(PLUGIN, [doorbell]);

      await Promise.resolve();
    });

    assert.deepEqual(api.calls, [{ accessories: [doorbell], kind: "publish", pluginIdentifier: PLUGIN }]);
    assert.deepEqual(api.serverLog, [], "a publish under a qualified plugin identifier logs nothing");
    assert.equal(doorbell._associatedPlugin, PLUGIN);
    assert.equal(doorbell._associatedPlatform, undefined, "an external accessory belongs to no platform");
    assert.equal(doorbell._associatedHAPAccessory.bridged, false, "publishing must bridge nothing");

    api.registerPlatformAccessories(PLUGIN, PLATFORM, [doorbell]);

    assert.equal(doorbell._associatedHAPAccessory.bridged, true, "publishing must cache nothing, so a later registration is no duplicate");
  });

  test("restore stamps the plugin and platform, caches and bridges each accessory, and records no call", () => {

    const api = setup();
    const restored = accessoryNamed(api, "Restored");
    const duplicate = new api.platformAccessory("Restored", restored.UUID);

    api.restorePlatformAccessories({ accessories: [restored], platform: { configureAccessory: (): void => undefined }, platformName: PLATFORM,
      pluginIdentifier: PLUGIN });

    assert.deepEqual(api.calls, [], "a restore is Homebridge's act, not the plugin's, so nothing is recorded");
    assert.equal(restored._associatedPlugin, PLUGIN);
    assert.equal(restored._associatedPlatform, PLATFORM);
    assert.equal(restored._associatedHAPAccessory.bridged, true, "a restored accessory must be on the bridge");

    assert.throws(() => api.registerPlatformAccessories(PLUGIN, PLATFORM, [duplicate]), warnedWith(api, SKIPPING_DUPLICATE));
    assert.equal(duplicate._associatedHAPAccessory.bridged, false, "a restored accessory is cached, so registering its UUID is skipped");

    api.unregisterPlatformAccessories(PLUGIN, PLATFORM, [restored]);

    assert.equal(restored._associatedHAPAccessory.bridged, false, "a restored accessory unregisters from the bridge it was restored onto");
  });

  test("restore hands each accessory to configureAccessory off the bridge and carrying Homebridge's FirmwareRevision placeholder, keeps a revision the platform " +
    "writes there, and bridges it afterward", () => {

    const api = setup();
    const restored = accessoryNamed(api, "Restored");
    const firmware = restored.getService(hap.Service.AccessoryInformation)?.getCharacteristic(hap.Characteristic.FirmwareRevision) ??
      assert.fail("the accessory must carry an information service");
    const seen: { bridged: boolean; revision: unknown }[] = [];

    // A platform reads what Homebridge hands it and writes the device's own revision, as a plugin's configureAccessory does.
    const platform = {

      configureAccessory: (accessory: PlatformAccessory): void => {

        const revision = accessory.getService(hap.Service.AccessoryInformation)?.getCharacteristic(hap.Characteristic.FirmwareRevision);

        seen.push({ bridged: accessory._associatedHAPAccessory.bridged, revision: revision?.value });
        revision?.updateValue("4.1.0");
      }
    };

    assert.equal(firmware.value, "0.0.0", "precondition: HAP seeds FirmwareRevision with its own default");

    api.restorePlatformAccessories({ accessories: [restored], platform, platformName: PLATFORM, pluginIdentifier: PLUGIN });

    assert.deepEqual(seen, [{ bridged: false, revision: "0" }], "the platform sees Homebridge's placeholder on an accessory not yet on the bridge");
    assert.equal(firmware.value, "4.1.0", "a revision the platform writes there survives the restore");
    assert.equal(restored._associatedHAPAccessory.bridged, true, "and the accessory is bridged once configureAccessory returns");
    assert.deepEqual(restored.changesTo(hap.Characteristic.FirmwareRevision).map(({ newValue, reason }) => ({ newValue, reason })),
      [ { newValue: "0", reason: "write" }, { newValue: "4.1.0", reason: "update" } ], "the placeholder is a write HAP raises a change for, ahead of the platform's");
  });

  test("restore stamps and caches its whole batch before any configureAccessory, so a registration there of a later accessory's UUID is skipped as a " +
    "duplicate, that instance stays off the bridge, and the restore throws Homebridge's warning once its loop ends", () => {

    // HAP bridges a second instance of a UUID its bridge already holds without complaint, so a registration the restore let through would leave the bridge holding
    // the second accessory's UUID twice. Only the copy staying off the bridge shows the skip.
    const api = setup();
    const first = accessoryNamed(api, "First");
    const second = accessoryNamed(api, "Second");
    const copy = new api.platformAccessory("Second Copy", second.UUID);
    const seen: string[] = [];
    const stamps: { platform: string | undefined; plugin: string | undefined }[] = [];

    // The first accessory's configureAccessory reads each accessory's stamps and registers a new instance carrying the second's UUID, as a plugin adding a
    // companion accessory there does.
    const platform = {

      configureAccessory: (accessory: PlatformAccessory): void => {

        seen.push(accessory.displayName);

        if(accessory === first) {

          stamps.push(...[ first, second ].map((stamped) => ({ platform: stamped._associatedPlatform, plugin: stamped._associatedPlugin })));
          api.registerPlatformAccessories(PLUGIN, PLATFORM, [copy]);
        }
      }
    };

    assert.throws(() => api.restorePlatformAccessories({ accessories: [ first, second ], platform, platformName: PLATFORM, pluginIdentifier: PLUGIN }),
      warnedWith(api, SKIPPING_DUPLICATE));
    assert.deepEqual(stamps, [ { platform: PLATFORM, plugin: PLUGIN }, { platform: PLATFORM, plugin: PLUGIN } ],
      "inside the first configureAccessory, every accessory of the batch already carries the plugin identifier and platform name");
    assert.equal(copy._associatedHAPAccessory.bridged, false, "the second is already cached, so the registered instance is a duplicate and stays off the bridge");
    assert.deepEqual(seen, [ "First", "Second" ], "the registered instance never reaches configureAccessory, and the second reaches it once");
    assert.equal(second._associatedHAPAccessory.bridged, true, "the second is bridged once its configureAccessory returns");
    assert.equal(second._associatedHAPAccessory.bridge?.bridgedAccessories.filter(({ UUID }) => UUID === second.UUID).length, 1,
      "and the bridge holds the second's UUID once");
  });

  test("restore skips an accessory an earlier configureAccessory in its batch unregistered, never configuring or bridging it", () => {

    const api = setup();
    const first = accessoryNamed(api, "First");
    const second = accessoryNamed(api, "Second");
    const seen: string[] = [];

    // The unregister takes the second out of the cache before HAP refuses to remove an accessory its bridge does not hold yet, the refusal a plugin unregistering
    // there meets under Homebridge too.
    const platform = {

      configureAccessory: (accessory: PlatformAccessory): void => {

        seen.push(accessory.displayName);

        if(accessory === first) {

          assert.throws(() => api.unregisterPlatformAccessories(PLUGIN, PLATFORM, [second]), { message: "Cannot find the bridged Accessory to remove." });
        }
      }
    };

    api.restorePlatformAccessories({ accessories: [ first, second ], platform, platformName: PLATFORM, pluginIdentifier: PLUGIN });

    assert.deepEqual(seen, ["First"], "the unregistered second never reaches configureAccessory");
    assert.equal(second._associatedHAPAccessory.bridged, false, "and is never bridged");
    assert.equal(first._associatedHAPAccessory.bridged, true, "while the first is restored as usual");
  });

  test("restore skips an accessory an earlier configureAccessory in its batch swapped for a new instance through an update, reading the cache as it stands, " +
    "by identity", () => {

    // A plugin swaps in a new instance of a cached accessory by saving it through an update, which puts it in the cache in place of the instance sharing its UUID.
    // Homebridge's loop then finds the instance it was about to restore missing from its cache and skips it, though the cache still holds its UUID. The new
    // instance was never registered, so Homebridge's save cannot write it, and the restore throws that error once its loop ends.
    const api = setup();
    const first = accessoryNamed(api, "First");
    const second = accessoryNamed(api, "Second");
    const swap = new api.platformAccessory("Second Swap", second.UUID);
    const seen: string[] = [];

    const platform = {

      configureAccessory: (accessory: PlatformAccessory): void => {

        seen.push(accessory.displayName);

        if(accessory === first) {

          api.updatePlatformAccessories([swap]);
        }
      }
    };

    assert.throws(() => api.restorePlatformAccessories({ accessories: [ first, second ], platform, platformName: PLATFORM, pluginIdentifier: PLUGIN }),
      warnedWith(api, SAVE_FAILED + "Cannot serialize accessory 'Second Swap'", SAVE_NOT_PERSISTED));
    assert.deepEqual(seen, ["First"], "the swapped-out second never reaches configureAccessory, though an instance carrying its UUID is cached");
    assert.equal(second._associatedHAPAccessory.bridged, false, "and is never bridged");
  });

  test("restore runs Homebridge's loop over its batch alone, so an accessory registered before it is not configured again and stays cached and bridged", () => {

    const api = setup();
    const registered = accessoryNamed(api, "Registered");
    const restored = accessoryNamed(api, "Restored");
    const copy = new api.platformAccessory("Registered Copy", registered.UUID);
    const seen: string[] = [];

    api.registerPlatformAccessories(PLUGIN, PLATFORM, [registered]);
    api.restorePlatformAccessories({ accessories: [restored], platform: recordingPlatform(seen),
      platformName: PLATFORM, pluginIdentifier: PLUGIN });

    assert.deepEqual(seen, ["Restored"], "only the batch reaches configureAccessory");
    assert.equal(restored._associatedHAPAccessory.bridged, true, "the restored accessory is bridged");
    assert.equal(registered._associatedHAPAccessory.bridged, true, "and the registered one stays on the bridge");

    // Homebridge names the cache in its skip of a cached UUID and the bridge in its skip of a bridged one, so the cache's sentence shows the accessory still cached.
    assert.throws(() => api.registerPlatformAccessories(PLUGIN, PLATFORM, [copy]), warnedWith(api, "same UUID as existing accessory 'Registered'"));
  });

  test("restore configures an accessory HAP refuses to bridge, then Homebridge orphans it out of the cache and restores the rest, and the restore throws its " +
    "warning once", () => {

    // Another API's bridge holds the middle accessory, so HAP refuses to bridge it here once its configureAccessory has returned.
    const elsewhere = setup();
    const api = setup();
    const first = accessoryNamed(api, "First");
    const middle = accessoryNamed(api, "Middle");
    const last = accessoryNamed(api, "Last");
    const again = new api.platformAccessory("Middle Again", middle.UUID);
    const seen: string[] = [];

    elsewhere.registerPlatformAccessories(PLUGIN, PLATFORM, [middle]);

    assert.throws(() => api.restorePlatformAccessories({ accessories: [ first, middle, last ],
      platform: recordingPlatform(seen), platformName: PLATFORM, pluginIdentifier: PLUGIN }),
    warnedWith(api, "Could not restore cached accessory 'Middle'"));
    assert.deepEqual(seen, [ "First", "Middle", "Last" ], "Homebridge configures each accessory before it bridges it, the refused one included, and carries on");
    assert.deepEqual(first._associatedHAPAccessory.bridge?.bridgedAccessories, [ first._associatedHAPAccessory, last._associatedHAPAccessory ],
      "the rest are bridged here, and the refused one is not");

    // A new instance of the orphan's UUID registers here unskipped, which shows the orphan left the cache.
    api.registerPlatformAccessories(PLUGIN, PLATFORM, [again]);

    assert.equal(again._associatedHAPAccessory.bridged, true, "the orphan's UUID has left the cache");
  });

  test("restore of an accessory already registered on the same API configures it, then Homebridge orphans it out of the cache when HAP refuses to bridge it " +
    "again, so a copy's registration meets the bridge's skip rather than the cache's", () => {

    // The accessory is cached before the restore and is the restore's batch too, so the cache the restore returns to holds what it held before less the batch,
    // and the orphan does not come back with it.
    const api = setup();
    const lamp = accessoryNamed(api, "Lamp");
    const copy = new api.platformAccessory("Lamp Copy", lamp.UUID);
    const seen: string[] = [];

    api.registerPlatformAccessories(PLUGIN, PLATFORM, [lamp]);

    assert.throws(() => api.restorePlatformAccessories({ accessories: [lamp], platform: recordingPlatform(seen), platformName: PLATFORM, pluginIdentifier: PLUGIN }),
      warnedWith(api, "Could not restore cached accessory 'Lamp': Tried to bridge Lamp while it was already bridged by Homebridge"));
    assert.deepEqual(seen, ["Lamp"], "Homebridge configures the accessory before HAP refuses to bridge it");
    assert.equal(lamp._associatedHAPAccessory.bridged, true, "the accessory stays on the bridge its registration put it on");

    // Homebridge names the cache in its skip of a cached UUID and the bridge in its skip of a bridged one, so the bridge's sentence shows the orphan left the cache.
    assert.throws(() => api.registerPlatformAccessories(PLUGIN, PLATFORM, [copy]), warnedWith(api, "same UUID as existing bridged accessory 'Lamp'"));
    assert.equal(copy._associatedHAPAccessory.bridged, false, "and the copy stays off the bridge");
  });

  test("a registration from inside configureAccessory that Homebridge skips returns to the platform, so Homebridge's loop configures and bridges the whole " +
    "batch, and the restore throws the warning once", () => {

    const api = setup();
    const first = accessoryNamed(api, "First");
    const second = accessoryNamed(api, "Second");
    const third = accessoryNamed(api, "Third");
    const copy = new api.platformAccessory("First Copy", first.UUID);
    const seen: string[] = [];
    let returned = false;

    // The second's configureAccessory registers a new instance of the first's UUID, which Homebridge skips with a warning, and carries on past the call.
    const platform = {

      configureAccessory: (accessory: PlatformAccessory): void => {

        seen.push(accessory.displayName);

        if(accessory === second) {

          api.registerPlatformAccessories(PLUGIN, PLATFORM, [copy]);
          returned = true;
        }
      }
    };

    assert.throws(() => api.restorePlatformAccessories({ accessories: [ first, second, third ], platform, platformName: PLATFORM, pluginIdentifier: PLUGIN }),
      warnedWith(api, SKIPPING_DUPLICATE));
    assert.equal(returned, true, "the registration nested in the restore returns to the platform rather than throwing there");
    assert.deepEqual(seen, [ "First", "Second", "Third" ], "Homebridge's loop runs on past the skip");
    assert.ok([ first, second, third ].every((accessory) => accessory._associatedHAPAccessory.bridged), "and bridges every accessory of the batch");
    assert.equal(copy._associatedHAPAccessory.bridged, false, "while the skipped instance stays off the bridge");
    assert.deepEqual(api.calls.map(({ kind }) => kind), ["register"], "the registration Homebridge accepted is recorded");
  });

  test("platformAccessory is a subclass of Homebridge's own class, made for each API, which lists every accessory it makes in order", () => {

    const api = setup();
    const other = setup();
    const lamp = accessoryNamed(api, "Lamp");
    const fan = accessoryNamed(api, "Fan");
    const elsewhere = accessoryNamed(other, "Elsewhere");

    assert.ok(lamp instanceof runtime.PlatformAccessory, "an accessory must be Homebridge's own PlatformAccessory");
    assert.notEqual(api.platformAccessory, other.platformAccessory, "each API makes its own class");
    assert.deepEqual(api.accessories, [ lamp, fan ], "the API lists the accessories made through it, in order");
    assert.deepEqual(other.accessories, [elsewhere], "and only those");
  });

  test("the API is an EventEmitter a plugin subscribes to for Homebridge's lifecycle events", () => {

    const api = setup();
    const heard: string[] = [];

    api.on("didFinishLaunching", () => heard.push("didFinishLaunching"));
    api.on("shutdown", () => heard.push("shutdown"));
    api.emit("didFinishLaunching");
    api.emit("shutdown");

    assert.deepEqual(heard, [ "didFinishLaunching", "shutdown" ]);
  });
});

describe("TestHomebridgeApi - Homebridge's server log and the strict throw", () => {

  test("a duplicate registration throws Homebridge's warning once the rest are bridged and the call is recorded, keeps the line in serverLog, and prints " +
    "nothing", (t) => {

    const writes = consoleWrites(t);
    const api = setup();
    const lamp = accessoryNamed(api, "Lamp");
    const duplicate = new api.platformAccessory("Lamp Copy", lamp.UUID);
    const fan = accessoryNamed(api, "Fan");

    api.registerPlatformAccessories(PLUGIN, PLATFORM, [lamp]);

    assert.throws(() => api.registerPlatformAccessories(PLUGIN, PLATFORM, [ duplicate, fan ]), warnedWith(api, SKIPPING_DUPLICATE));
    assert.equal(fan._associatedHAPAccessory.bridged, true, "Homebridge bridges the rest before the call throws");
    assert.equal(duplicate._associatedHAPAccessory.bridged, false, "and leaves the duplicate off the bridge");
    assert.deepEqual(api.calls.map(({ accessories }) => accessories), [ [lamp], [ duplicate, fan ] ], "the call Homebridge accepted is recorded before it throws");
    assert.deepEqual(api.serverLog.map(({ level }) => level), ["warn"], "the line Homebridge logged is kept");
    assert.ok(expectAt(api.serverLog, 0).message.endsWith(SKIPPING_DUPLICATE), "as Homebridge wrote it");
    assert.equal(writes(), 0, "and Homebridge's logger prints nothing");
  });

  test("a registration that warns and then meets HAP's refusal throws the refusal unchanged and records nothing, the warning kept in serverLog", () => {

    // Another API's bridge holds the lamp, so HAP refuses to bridge it here once Homebridge has skipped the copy of the fan this API's bridge holds.
    const elsewhere = setup();
    const api = setup();
    const lamp = accessoryNamed(elsewhere, "Lamp");
    const fan = accessoryNamed(api, "Fan");
    const copy = new api.platformAccessory("Fan Copy", fan.UUID);

    elsewhere.registerPlatformAccessories(PLUGIN, PLATFORM, [lamp]);
    api.registerPlatformAccessories(PLUGIN, PLATFORM, [fan]);

    assert.throws(() => api.registerPlatformAccessories(PLUGIN, PLATFORM, [ copy, lamp ]),
      { message: "Tried to bridge Lamp while it was already bridged by Homebridge", name: "Error" });
    assert.deepEqual(api.calls.map(({ accessories }) => accessories), [[fan]], "a call HAP refuses records nothing");
    assert.deepEqual(api.serverLog.map(({ level }) => level), ["warn"], "the warning Homebridge logged before the refusal is kept");
    assert.ok(expectAt(api.serverLog, 0).message.endsWith(SKIPPING_DUPLICATE), "as Homebridge wrote it");
    assert.deepEqual(api.takeServerWarnings(), api.serverLog, "and held until the row takes it, as the refusal thrown in its place took nothing");
  });

  test("a duplicate registration a didFinishLaunching listener makes throws Homebridge's warning from the suite's emit", () => {

    const api = setup();
    const lamp = accessoryNamed(api, "Lamp");

    api.registerPlatformAccessories(PLUGIN, PLATFORM, [lamp]);
    api.on("didFinishLaunching", (): void => {

      api.registerPlatformAccessories(PLUGIN, PLATFORM, [new api.platformAccessory("Lamp Copy", lamp.UUID)]);
    });

    assert.throws(() => api.emit("didFinishLaunching"), warnedWith(api, SKIPPING_DUPLICATE));
  });

  test("a registration on a second API from inside a restore's configureAccessory that warns and then meets HAP's refusal hands its warning to the restore's " +
    "throw, the line staying in the second API's serverLog", () => {

    // The restoring API's bridge holds the lamp, so HAP refuses to bridge it on the second API once Homebridge there has skipped the copy of the fan its own bridge
    // holds. The platform catches the refusal, as a plugin that catches its own errors does, and Homebridge's restore loop runs on.
    const restorer = setup();
    const registrar = setup();
    const lamp = accessoryNamed(restorer, "Lamp");
    const restored = accessoryNamed(restorer, "Restored");
    const fan = accessoryNamed(registrar, "Fan");
    const copy = new registrar.platformAccessory("Fan Copy", fan.UUID);
    const refusals: unknown[] = [];

    restorer.registerPlatformAccessories(PLUGIN, PLATFORM, [lamp]);
    registrar.registerPlatformAccessories(PLUGIN, PLATFORM, [fan]);

    const platform = {

      configureAccessory: (): void => {

        try {

          registrar.registerPlatformAccessories(PLUGIN, PLATFORM, [ copy, lamp ]);
        } catch(error) {

          refusals.push(error);
        }
      }
    };

    assert.throws(() => restorer.restorePlatformAccessories({ accessories: [restored], platform, platformName: PLATFORM, pluginIdentifier: PLUGIN }),
      warnedWith(registrar, SKIPPING_DUPLICATE));
    assert.deepEqual(refusals.map((refusal) => (refusal as Error).message), ["Tried to bridge Lamp while it was already bridged by Homebridge"],
      "the nested call threw HAP's refusal to the platform after Homebridge warned");
    assert.equal(restored._associatedHAPAccessory.bridged, true, "the restore loop ran on past the refusal");
    assert.deepEqual(registrar.serverLog.map(({ level }) => level), ["warn"], "the line sits in the serverLog of the API whose call logged it");
    assert.deepEqual(restorer.serverLog, [], "and not in the restoring API's");
  });

  test("a registration of an accessory whose context refers to itself throws Homebridge's error that its save failed, the accessory registered and bridged", () => {

    const api = setup();
    const lamp = accessoryNamed(api, "Lamp");
    const context: { self?: unknown } = {};

    context.self = context;
    lamp.context = context;

    assert.throws(() => api.registerPlatformAccessories(PLUGIN, PLATFORM, [lamp]), warnedWith(api, SAVE_FAILED, SAVE_NOT_PERSISTED));
    assert.ok(expectAt(api.serverLog, 0).message.includes("circular structure"), "the save failed on the context Homebridge could not write");
    assert.equal(lamp._associatedHAPAccessory.bridged, true, "Homebridge accepted the registration before its save failed");
    assert.deepEqual(api.calls.map(({ kind }) => kind), ["register"]);
  });

  test("an update of an accessory never registered or restored throws Homebridge's error that its save failed, and so does the next call that saves", () => {

    // Homebridge's save writes the whole cache and refuses an accessory without its plugin and platform stamps, so the cache keeps failing every save after.
    const api = setup();
    const unstamped = accessoryNamed(api, "Unstamped");
    const lamp = accessoryNamed(api, "Lamp");
    const refusal = SAVE_FAILED + "Cannot serialize accessory 'Unstamped' - missing associated plugin";

    assert.throws(() => api.updatePlatformAccessories([unstamped]), warnedWith(api, refusal, SAVE_NOT_PERSISTED));
    assert.throws(() => api.registerPlatformAccessories(PLUGIN, PLATFORM, [lamp]), warnedWith(api, refusal, SAVE_NOT_PERSISTED));
    assert.equal(lamp._associatedHAPAccessory.bridged, true, "Homebridge accepted the registration before its save failed");
    assert.deepEqual(api.calls.map(({ kind }) => kind), [ "update", "register" ]);
  });

  test("a publish under a platform name rather than a plugin identifier records Homebridge's info line in serverLog and throws nothing", () => {

    const api = setup();
    const doorbell = accessoryNamed(api, "Doorbell");

    api.publishExternalAccessories(PLATFORM, [doorbell]);

    assert.deepEqual(api.serverLog.map(({ level }) => level), ["info"]);
    assert.ok(expectAt(api.serverLog, 0).message.includes("incorrectly registered an external accessory using the platform name (TestPlatform)"),
      "the line is the one Homebridge logged");
    assert.deepEqual(api.calls, [{ accessories: [doorbell], kind: "publish", pluginIdentifier: PLATFORM }]);
  });

  test("serverLog keeps the line a characteristic warning draws inside a call at Homebridge's level and without its colors, the warning's stack only while " +
    "Homebridge's debug is on, and no line from outside every call", async (t) => {

    const writes = consoleWrites(t);
    const chalkUrl = pathToFileURL(createRequire(LOGGER_URL).resolve("chalk")).href;
    const { default: chalk } = await import(chalkUrl) as { default: { cyan: (text: string) => string; level: number } };
    const { level } = chalk;

    t.after(() => {

      chalk.level = level;
    });

    chalk.level = 1;

    assert.notEqual(chalk.cyan(PLUGIN), PLUGIN, "precondition: Homebridge colors the plugin's prefix");

    const api = setup();
    const lamp = restoreClamped(api);

    assert.deepEqual(api.serverLog.map(({ level: logged }) => logged), ["info"], "the warning inside the restore logs one line, at info, and its stack is dropped");
    assert.ok(expectAt(api.serverLog, 0).message.startsWith("[homebridge-test] This plugin generated a warning from the characteristic 'Brightness':"),
      "the line carries Homebridge's prefix without its escape codes");
    assert.deepEqual(lamp.takeWarnings().map((warning) => warning.type), RESTORE_CLAMPED_KINDS,
      "the warning raised after the restore returned is recorded on the accessory and nowhere in serverLog");

    await homebridgeDebugOn(t);

    const debugging = setup();
    const debuggingLamp = restoreClamped(debugging);

    assert.deepEqual(debugging.serverLog.map(({ level: logged }) => logged), [ "info", "debug" ], "with Homebridge's debug on, the warning's stack is kept at debug");
    assert.deepEqual(debuggingLamp.takeWarnings().map((warning) => warning.type), RESTORE_CLAMPED_KINDS,
      "and the accessory records each clamp, as it does with Homebridge's debug off");
    assert.equal(writes(), 0);
  });

  test("construction throws Homebridge's warning when the bridge service warns while it is built, printing nothing", (t) => {

    // A bridge service that warns as it is built, as one would whose Homebridge release needs an option the double does not pass.
    class WarningBridgeService extends runtime.BridgeService {

      public constructor(...args: ConstructorParameters<typeof runtime.BridgeService>) {

        super(...args);
        runtime.Logger.internal.warn("Failed to clear stale external accessories metadata file:", "the option is missing.");
      }
    }

    const writes = consoleWrites(t);

    assert.throws(() => new TestHomebridgeApi({ ...runtime, BridgeService: WarningBridgeService }),
      warnedWith(null, "Failed to clear stale external accessories metadata file: the option is missing."));
    assert.equal(writes(), 0);
  });

  test("construction throws Homebridge's warning when Homebridge's API warns while it is built, printing nothing", (t) => {

    // An API that warns as it is built, as one would whose Homebridge release logs from its constructor.
    class WarningApi extends runtime.HomebridgeAPI {

      public constructor() {

        super();
        runtime.Logger.internal.warn("Homebridge's API could not read its configuration:", "the file is missing.");
      }
    }

    const writes = consoleWrites(t);

    assert.throws(() => new TestHomebridgeApi({ ...runtime, HomebridgeAPI: WarningApi }),
      warnedWith(null, "Homebridge's API could not read its configuration: the file is missing."));
    assert.equal(writes(), 0);
  });
});

describe("TestHomebridgeApi - the held set and assertNoServerWarnings", () => {

  test("a warning plugin code caught still fails assertNoServerWarnings, which quotes the line", () => {

    const api = setup();
    const lamp = accessoryNamed(api, "Lamp");
    const copy = new api.platformAccessory("Lamp Copy", lamp.UUID);
    const caught: unknown[] = [];

    api.registerPlatformAccessories(PLUGIN, PLATFORM, [lamp]);

    // A plugin that catches its own errors, here around a registration its didFinishLaunching listener makes, swallows the strict throw and carries on.
    api.on("didFinishLaunching", (): void => {

      try {

        api.registerPlatformAccessories(PLUGIN, PLATFORM, [copy]);
      } catch(error) {

        caught.push(error);
      }
    });

    api.emit("didFinishLaunching");

    assert.ok(expectAt(caught, 0) instanceof HomebridgeServerWarning, "precondition: the strict throw reached the plugin, which caught it");

    const line = expectAt(api.serverLog, 0);

    assert.throws(() => assertNoServerWarnings(api), (error: unknown): boolean => {

      assert.ok(error instanceof assert.AssertionError, "the check fails as an assertion does");
      assert.ok(error.message.includes(line.level + ": " + line.message), "quoting the line Homebridge logged at its level: " + error.message);

      return true;
    });
  });

  test("a taken warning leaves assertNoServerWarnings silent and serverLog whole", () => {

    const api = setup();
    const lamp = accessoryNamed(api, "Lamp");

    api.registerPlatformAccessories(PLUGIN, PLATFORM, [lamp]);

    assert.throws(() => api.registerPlatformAccessories(PLUGIN, PLATFORM, [new api.platformAccessory("Lamp Copy", lamp.UUID)]), HomebridgeServerWarning);

    const taken = api.takeServerWarnings();

    assert.deepEqual(taken.map(({ level }) => level), ["warn"], "the take answers the warning Homebridge logged");
    assert.ok(expectAt(taken, 0).message.endsWith(SKIPPING_DUPLICATE), "as Homebridge wrote it");
    assert.deepEqual(api.serverLog, taken, "serverLog keeps the line the take answered");
    assert.doesNotThrow(() => assertNoServerWarnings(api), "and nothing is left held");
  });

  test("a second take answers nothing, and a take after a later warning answers that warning alone", () => {

    const api = setup();
    const lamp = accessoryNamed(api, "Lamp");

    api.registerPlatformAccessories(PLUGIN, PLATFORM, [lamp]);

    assert.throws(() => api.registerPlatformAccessories(PLUGIN, PLATFORM, [new api.platformAccessory("Lamp Copy", lamp.UUID)]), HomebridgeServerWarning);
    assert.equal(api.takeServerWarnings().length, 1, "precondition: the first take answers the warning");
    assert.deepEqual(api.takeServerWarnings(), [], "a second take answers nothing, as the first moved the cursor past the line");

    assert.throws(() => api.registerPlatformAccessories(PLUGIN, PLATFORM, [new api.platformAccessory("Lamp Again", lamp.UUID)]), HomebridgeServerWarning);

    const later = api.takeServerWarnings();

    assert.deepEqual(later, [expectAt(api.serverLog, 1)], "a later take answers only the line Homebridge logged since");
    assert.ok(expectAt(later, 0).message.includes("'Lamp Again'"), "the later warning's own line");
  });

  test("info and debug lines are never held, so a take answers nothing and assertNoServerWarnings stays silent", async (t) => {

    await homebridgeDebugOn(t);

    const api = setup();
    const lamp = restoreClamped(api);

    api.publishExternalAccessories(PLATFORM, [accessoryNamed(api, "Doorbell")]);

    assert.deepEqual(api.serverLog.map(({ level }) => level), [ "info", "debug", "info" ],
      "precondition: the clamp inside the restore logs at info with its stack at debug, and a publish under a platform name logs at info");
    assert.deepEqual(lamp.takeWarnings().map((warning) => warning.type), RESTORE_CLAMPED_KINDS,
      "precondition: the accessory records each clamp, which the row takes so the check reads the server lines alone");
    assert.deepEqual(api.takeServerWarnings(), [], "a take holds warn and error lines alone");
    assert.doesNotThrow(() => assertNoServerWarnings(api));
  });

  test("a warning a call nested on a second API logged is held by that API, which the outer call's throw quotes, and the outer call's API holds nothing", () => {

    // The restoring API's configureAccessory registers a copy of an accessory the second API's bridge holds, which Homebridge there skips with a warning.
    const restorer = setup();
    const registrar = setup();
    const restored = accessoryNamed(restorer, "Restored");
    const fan = accessoryNamed(registrar, "Fan");
    const copy = new registrar.platformAccessory("Fan Copy", fan.UUID);

    registrar.registerPlatformAccessories(PLUGIN, PLATFORM, [fan]);

    const platform = {

      configureAccessory: (): void => {

        registrar.registerPlatformAccessories(PLUGIN, PLATFORM, [copy]);
      }
    };

    assert.throws(() => restorer.restorePlatformAccessories({ accessories: [restored], platform, platformName: PLATFORM, pluginIdentifier: PLUGIN }),
      warnedWith(registrar, SKIPPING_DUPLICATE));
    assert.deepEqual(restorer.takeServerWarnings(), [], "the restoring API holds nothing of the nested call's");
  });

  test("assertNoServerWarnings on an API shared across tests fails once for a warning left held, and then passes", () => {

    const api = setup();
    const lamp = accessoryNamed(api, "Lamp");

    api.registerPlatformAccessories(PLUGIN, PLATFORM, [lamp]);

    assert.throws(() => api.registerPlatformAccessories(PLUGIN, PLATFORM, [new api.platformAccessory("Lamp Copy", lamp.UUID)]), HomebridgeServerWarning);
    assert.throws(() => assertNoServerWarnings(api), assert.AssertionError, "the first check fails on the warning left held");
    assert.doesNotThrow(() => assertNoServerWarnings(api), "and the next passes, because the failing check took the line, so one leak fails one test");
  });

  test("a warning HAP raised on an unregistered accessory fails assertNoServerWarnings, which quotes it, and a warning the test took leaves it silent", () => {

    const api = setup();
    const lamp = accessoryNamed(api, "Lamp");
    const brightness = lamp.addService(hap.Service.Lightbulb, "Lamp Bulb").getCharacteristic(hap.Characteristic.Brightness);

    // HAP clamps a value past the characteristic's maximum with a "warn-message" warning, and an unregistered accessory has no printer to log it.
    brightness.updateValue(500);

    const warning = expectAt(lamp.warnings, 0);

    assert.equal(warning.type, CharacteristicWarningType.WARN_MESSAGE, "precondition: HAP clamped the value with a warn-message warning");
    assert.deepEqual(api.serverLog, [], "precondition: nothing reached the server log");
    assert.throws(() => assertNoServerWarnings(api), (error: unknown): boolean => {

      assert.ok(error instanceof assert.AssertionError, "the check fails as an assertion does");
      assert.ok(error.message.startsWith("HAP raised a warning or an error on an accessory that the test did not take.\n"), "naming HAP's warning: " + error.message);
      assert.ok(error.message.includes("warn-message: characteristic 'Brightness' of accessory 'Lamp': " + warning.message),
        "and quoting its kind, its characteristic, its accessory and its message: " + error.message);

      return true;
    });

    brightness.updateValue(600);

    assert.deepEqual(lamp.takeWarnings().map((warning) => warning.type), [CharacteristicWarningType.WARN_MESSAGE],
      "precondition: the test takes the warn-message warning it drew");
    assert.doesNotThrow(() => assertNoServerWarnings(api), "and a taken warning leaves the check silent");
  });

  test("a warning a trigger draws on a registered accessory outside every call fails assertNoServerWarnings, and an error-message warning inside a call is " +
    "quoted as Homebridge's line and from the accessory's record alike", async () => {

    const api = setup();
    const lamp = accessoryNamed(api, "Lamp");
    const on = lamp.addService(hap.Service.Lightbulb, "Lamp Bulb").getCharacteristic(hap.Characteristic.On);
    const model = lamp.getService(hap.Service.AccessoryInformation)?.getCharacteristic(hap.Characteristic.Model) ??
      assert.fail("the accessory must carry an information service");

    api.registerPlatformAccessories(PLUGIN, PLATFORM, [lamp]);

    on.onGet(() => {

      throw new Error("The device dropped the read.");
    });

    await assert.rejects(triggerGet(on), HomeKitRequestError);

    assert.equal(api.serverLog.length, 0, "precondition: the trigger runs outside every call, so the line Homebridge's printer logged for its warning was dropped");
    assert.throws(() => assertNoServerWarnings(api), /error-message: characteristic 'On' of accessory 'Lamp': Unhandled error thrown inside read handler/u,
      "the record alone holds the trigger's warning, and the check fails on it");

    // A restore runs the platform's configureAccessory inside its call, and HAP refuses a null Model with an "error-message" warning, which the printer Homebridge
    // attached to the registered lamp logs at error, so the restore throws Homebridge's line and the lamp's record holds the warning too.
    const platform = {

      configureAccessory: (): void => {

        model.updateValue(null);
      }
    };

    assert.throws(() => api.restorePlatformAccessories({ accessories: [accessoryNamed(api, "Porch")], platform, platformName: PLATFORM, pluginIdentifier: PLUGIN }),
      HomebridgeServerWarning);

    const line = expectAt(api.serverLog, 0);
    const warning = expectAt(lamp.warnings, 0);

    assert.equal(line.level, "error", "precondition: Homebridge's printer logged the warning at error");
    assert.equal(warning.type, CharacteristicWarningType.ERROR_MESSAGE, "precondition: the record holds the error-message warning");
    assert.throws(() => assertNoServerWarnings(api), (error: unknown): boolean => {

      assert.ok(error instanceof assert.AssertionError, "the check fails as an assertion does");
      assert.ok(error.message.includes("did not take.\nerror: " + line.message), "quoting Homebridge's line: " + error.message);
      assert.ok(error.message.includes("did not take.\nerror-message: characteristic 'Model' of accessory 'Lamp': " + warning.message),
        "and the warning from the lamp's record: " + error.message);

      return true;
    });
  });

  test("a slow-read, slow-write or debug-message warning left on an accessory leaves assertNoServerWarnings silent, and the check still empties the record", () => {

    const api = setup();
    const lamp = accessoryNamed(api, "Lamp");
    const on = lamp.addService(hap.Service.Lightbulb, "Lamp Bulb").getCharacteristic(hap.Characteristic.On);
    const advisory = [ CharacteristicWarningType.SLOW_READ, CharacteristicWarningType.SLOW_WRITE, CharacteristicWarningType.DEBUG_MESSAGE ];

    // HAP's accessory server reports a slow request from a timer while a controller's request is out, so the row raises each kind on the characteristic's own
    // warning event, the channel every warning a characteristic raises goes through.
    for(const type of advisory) {

      on.emit("characteristic-warning", type, "HAP reported a " + type + " warning.");
    }

    assert.deepEqual(lamp.warnings.map((warning) => warning.type), advisory, "precondition: the accessory recorded each advisory warning");
    assert.doesNotThrow(() => assertNoServerWarnings(api), "Homebridge treats a slow request and a debug message as advice, so the check passes");
    assert.deepEqual(lamp.warnings, [], "and it takes them all the same, so the record is emptied");
  });

  test("a warn-message, error-message, timeout-read or timeout-write warning left on an accessory fails assertNoServerWarnings, which quotes each kind, and " +
    "the check still empties the record", () => {

    const api = setup();
    const lamp = accessoryNamed(api, "Lamp");
    const on = lamp.addService(hap.Service.Lightbulb, "Lamp Bulb").getCharacteristic(hap.Characteristic.On);
    const failing = [ CharacteristicWarningType.WARN_MESSAGE, CharacteristicWarningType.ERROR_MESSAGE, CharacteristicWarningType.TIMEOUT_READ,
      CharacteristicWarningType.TIMEOUT_WRITE ];

    // HAP's accessory server reports a timeout from a timer while a controller's request is out, so the row raises each kind on the characteristic's own warning
    // event, as the advisory row does.
    for(const type of failing) {

      on.emit("characteristic-warning", type, "HAP raised a warning of kind " + type + ".");
    }

    assert.deepEqual(lamp.warnings.map((warning) => warning.type), failing, "precondition: the accessory recorded each failing warning");
    assert.throws(() => assertNoServerWarnings(api), (error: unknown): boolean => {

      assert.ok(error instanceof assert.AssertionError, "the check fails as an assertion does");

      for(const type of failing) {

        assert.ok(error.message.includes(type + ": characteristic 'On' of accessory 'Lamp': HAP raised a warning of kind " + type + "."),
          "quoting the " + type + " warning after its kind: " + error.message);
      }

      return true;
    });
    assert.deepEqual(lamp.warnings, [], "and the check takes them before it fails, so the record is emptied");
  });
});

describe("watchServerWarnings", () => {

  test("a test whose own cleanup makes plugin code catch a warning Homebridge logs fails the check, its message quoting the line, and the next test passes",
    async () => {

      const { outcomes, output } = await runFixtureTests(
        "test('swallows a warning in its teardown', (t) => { const api = build(); t.after(() => swallow(api, 'Teardown Lamp')); });",
        "test('runs clean after it', () => { build(); });");

      assert.deepEqual(verdicts(outcomes), [ false, true ], "the check must run after the test's own cleanup, failing that test alone: " + output);
      assert.match(expectAt(outcomes, 0, "the teardown test's outcome").report, /did not take\.\n\s+warn: Accessory 'Teardown Lamp' .*Skipping duplicate\./u,
        "the failure must quote the line Homebridge logged during the teardown");
    });

  test("a double the file builds once and shares is checked after every test, failing each test that left a line on it", async () => {

    const { outcomes, output } = await runFixtureTests(
      "const shared = build();",
      "test('one', () => undefined);",
      "test('two', () => swallow(shared, 'Shared Lamp Two'));",
      "test('three', () => undefined);",
      "test('four', () => swallow(shared, 'Shared Lamp Four'));");

    assert.deepEqual(verdicts(outcomes), [ true, false, true, false ], "the shared double must be checked after every test, not after its first alone: " + output);
    assert.match(expectAt(outcomes, 1, "the second test's outcome").report, /'Shared Lamp Two'/u, "each failure quotes its own test's line");
    assert.match(expectAt(outcomes, 3, "the fourth test's outcome").report, /'Shared Lamp Four'/u, "and so does the later one");
    assert.doesNotMatch(expectAt(outcomes, 3, "the fourth test's outcome").report, /'Shared Lamp Two'/u, "which carries no line an earlier check took");
  });

  test("a test that takes the lines it drew passes, and leaves nothing for the next test", async () => {

    const { outcomes, output } = await runFixtureTests(
      "test('takes the lines it drew', () => { const api = build(); swallow(api, 'Taken Lamp'); api.takeServerWarnings(); });",
      "test('runs clean after it', () => undefined);");

    assert.deepEqual(verdicts(outcomes), [ true, true ], "a taken line must fail no test: " + output);
  });

  test("a test leaking on several doubles fails once, the check taking every double's lines, and the clean test after it passes", async () => {

    const { outcomes, output } = await runFixtureTests(
      "test('leaks on several doubles', () => { swallow(build(), 'First Lamp'); swallow(build(), 'Second Lamp'); });",
      "test('runs clean after it', () => undefined);");

    assert.deepEqual(verdicts(outcomes), [ false, true ], "the check must take every double's lines before it fails, leaving none for the next test: " + output);
    assert.match(expectAt(outcomes, 0, "the leaking test's outcome").report, /name: 'AggregateError'/u, "failing with one error that holds each double's failure");
  });

  test("a test leaking on several doubles fails with a message quoting each double's line, so a reporter printing only the message shows every one", async () => {

    const { outcomes, output } = await runFixtureTests(
      "test('leaks on several doubles', () => { swallow(build(), 'First Lamp'); swallow(build(), 'Second Lamp'); });");

    // TAP writes a failure's message as its block's `error` field, each line indented, and none of the errors an aggregate holds, so a line read there comes from
    // the message alone.
    const message = (/^ {2}error: \|-\n((?: {4}.*\n)+)/mu.exec(expectAt(outcomes, 0, "the leaking test's outcome").report)?.[1] ?? "").replaceAll(/^ {4}/gmu, "");

    assert.deepEqual(verdicts(outcomes), [false], "the leaking test must fail the check: " + output);
    assert.ok(message.startsWith("Warnings or errors that the test did not take were left on more than one API double.\n"),
      "the message must open with the aggregate's own sentence: " + output);
    assert.match(message, /warn: Accessory 'First Lamp' .*Skipping duplicate\./u, "the message must quote the first double's line: " + output);
    assert.match(message, /warn: Accessory 'Second Lamp' .*Skipping duplicate\./u, "and the second double's line: " + output);
  });

  test("a line a per-test double's timer logs after its test has ended fails the next test, quoting the line", async () => {

    // The second test waits on the timer itself, so the line is logged while it runs, whatever the host's speed.
    const { outcomes, output } = await runFixtureTests(
      "let late;",
      "test('arms a late swallow', () => { const api = build(); late = new Promise((resolve) => setTimeout(() => { swallow(api, 'Late Lamp'); resolve(); }, 1)); });",
      "test('waits on the late swallow', async () => { await late; });");

    assert.deepEqual(verdicts(outcomes), [ true, false ], "a double built for an earlier test must still be checked after the next: " + output);
    assert.match(expectAt(outcomes, 1, "the waiting test's outcome").report, /warn: Accessory 'Late Lamp' .*Skipping duplicate\./u, "quoting the late line");
  });

  test("a test that leaves a warning HAP raised on an accessory fails the check, its message quoting the warning, and the next test passes", async () => {

    const { outcomes, output } = await runFixtureTests(
      "test('leaves a clamp', () => { const api = build(); const lamp = new api.platformAccessory('Clamped Lamp', api.hap.uuid.generate('fixture.clamped'));",
      "  lamp.addService(api.hap.Service.Lightbulb, 'Clamped Bulb').getCharacteristic(api.hap.Characteristic.Brightness).updateValue(500); });",
      "test('runs clean after it', () => undefined);");

    assert.deepEqual(verdicts(outcomes), [ false, true ], "the check must fail the test that left the warning and take it, leaving none for the next test: " + output);
    assert.match(expectAt(outcomes, 0, "the leaking test's outcome").report,
      /did not take\.\n\s+warn-message: characteristic 'Brightness' of accessory 'Clamped Lamp': .*500/u, "the failure must quote the warning HAP raised");
  });
});

describe("TestPlatformAccessory - changes", () => {

  test("records every change reason HAP raises on an unregistered accessory, in order, each with its service and values", async () => {

    const api = setup();
    const accessory = accessoryNamed(api, "Lamp");

    // HAP names the information service while it builds the accessory, before the record exists.
    assert.equal(accessory.changes.length, 0, "a new accessory's record starts empty");

    const bulb = accessory.addService(hap.Service.Lightbulb, "Lamp Bulb");
    const on = bulb.getCharacteristic(hap.Characteristic.On);

    on.onGet(() => true);
    on.updateValue(true);
    await triggerSet(on, false);
    await triggerGet(on);
    on.sendEventNotification(false);

    assert.deepEqual(accessory.changes.map(({ newValue, oldValue, reason, service }) => ({ newValue, oldValue, reason, service })), [

      { newValue: true, oldValue: false, reason: "update", service: bulb },
      { newValue: false, oldValue: true, reason: "write", service: bulb },
      { newValue: true, oldValue: false, reason: "read", service: bulb },
      { newValue: false, oldValue: true, reason: "event", service: bulb }
    ]);

    assert.ok(accessory.changes.every((change) => change.characteristic === on), "each entry carries the characteristic HAP raised it on");
  });

  test("records each change on a registered accessory once, though HAP raises the accessory's own change event too while it is bridged", async () => {

    const api = setup();
    const accessory = accessoryNamed(api, "Lamp");
    const on = accessory.addService(hap.Service.Lightbulb, "Lamp Bulb").getCharacteristic(hap.Characteristic.On);

    api.registerPlatformAccessories(PLUGIN, PLATFORM, [accessory]);
    on.updateValue(true);
    await triggerSet(on, false);

    assert.deepEqual(accessory.changes.map((change) => change.reason), [ "update", "write" ]);
  });

  test("records changes on the information service HAP adds while it builds the accessory", () => {

    const api = setup();
    const accessory = accessoryNamed(api, "Lamp");
    const information = accessory.getService(hap.Service.AccessoryInformation) ?? assert.fail("the accessory must carry an information service");

    information.updateCharacteristic(hap.Characteristic.FirmwareRevision, "1.2.3");

    assert.deepEqual(accessory.changes.map(({ newValue, service }) => ({ newValue, service })), [{ newValue: "1.2.3", service: information }]);
  });

  test("keeps recording after an unregister strips the accessory of its listeners", () => {

    const api = setup();
    const accessory = accessoryNamed(api, "Lamp");
    const on = accessory.addService(hap.Service.Lightbulb, "Lamp Bulb").getCharacteristic(hap.Characteristic.On);

    api.registerPlatformAccessories(PLUGIN, PLATFORM, [accessory]);
    api.unregisterPlatformAccessories(PLUGIN, PLATFORM, [accessory]);
    on.updateValue(true);

    assert.deepEqual(accessory.changes.map((change) => change.reason), ["update"]);
  });

  test("records the services added after construction, through Homebridge's forwarder and through a controller's configuration", () => {

    const api = setup();
    const accessory = accessoryNamed(api, "Remote");
    const added = accessory.addService(hap.Service.Switch, "Remote Switch");
    const button = new hap.Service.StatelessProgrammableSwitch("Remote Button", "button");
    let configured = 0;

    // A controller hands HAP the services it builds, and HAP adds each through the accessory's own addService.
    const controller: Controller = {

      configureServices: (): void => {

        configured++;
      },
      constructServices: (): Record<string, typeof button> => ({ button }),
      controllerId: (): string => "homebridge-plugin-utils.test-controller",
      handleControllerRemoved: (): void => undefined,
      initWithServices: (): void => undefined
    };

    accessory.configureController(controller);

    assert.equal(configured, 1, "precondition: HAP configured the controller");
    assert.ok(accessory.services.includes(button), "precondition: HAP added the controller's service");

    added.getCharacteristic(hap.Characteristic.On).updateValue(true);
    button.getCharacteristic(hap.Characteristic.ProgrammableSwitchEvent).sendEventNotification(0);

    assert.deepEqual(accessory.changes.map((change) => change.service), [ added, button ]);
  });

  test("records a write of an unchanged value, which HAP raises like any other", () => {

    const api = setup();
    const accessory = accessoryNamed(api, "Lamp");
    const on = accessory.addService(hap.Service.Lightbulb, "Lamp Bulb").getCharacteristic(hap.Characteristic.On);

    on.updateValue(true);
    on.updateValue(true);

    assert.deepEqual(accessory.changes.map(({ newValue, oldValue }) => ({ newValue, oldValue })),
      [ { newValue: true, oldValue: false }, { newValue: true, oldValue: true } ]);
  });

  test("hears a service HAP removed and the accessory got back, and hears once a service re-added after leaving the services array some other way", () => {

    const api = setup();
    const accessory = accessoryNamed(api, "Lamp");
    const bulb = accessory.addService(hap.Service.Lightbulb, "Lamp Bulb");
    const on = bulb.getCharacteristic(hap.Characteristic.On);

    // HAP strips a removed service of every listener, so the re-add has to attach the record's listener again.
    accessory.removeService(bulb);
    accessory.addService(bulb);
    on.updateValue(true);

    assert.equal(accessory.changes.length, 1, "a service HAP removed must be heard again once re-added");

    // A service taken out of the array directly keeps its listeners, and HAP lets it back in, so the re-add must not attach a second listener.
    accessory.services.splice(accessory.services.indexOf(bulb), 1);
    accessory.addService(bulb);
    accessory.clearObservations();
    on.updateValue(false);

    assert.equal(accessory.changes.length, 1, "a service still carrying the record's listener must be heard once, never twice");
  });

  test("changesTo selects the recorded changes to any of the given characteristics, matched by UUID, in order", () => {

    const api = setup();
    const accessory = accessoryNamed(api, "Lamp");
    const bulb = accessory.addService(hap.Service.Lightbulb, "Lamp Bulb");

    bulb.getCharacteristic(hap.Characteristic.On).updateValue(true);
    bulb.getCharacteristic(hap.Characteristic.Brightness).updateValue(40);
    bulb.getCharacteristic(hap.Characteristic.On).updateValue(false);

    assert.deepEqual(accessory.changesTo(hap.Characteristic.On).map((change) => change.newValue), [ true, false ]);
    assert.deepEqual(accessory.changesTo(hap.Characteristic.Brightness, hap.Characteristic.On).map((change) => change.newValue), [ true, 40, false ],
      "several characteristics select in the order HAP raised the changes, not the order they are named");
    assert.deepEqual(accessory.changesTo(hap.Characteristic.Hue), [], "a characteristic that never changed selects nothing");
  });

  test("changesOn selects the recorded changes on one service among two, every change it raised or only those to the named characteristics, in order", () => {

    const api = setup();
    const accessory = accessoryNamed(api, "Lamp");
    const bulb = accessory.addService(hap.Service.Lightbulb, "Lamp Bulb");
    const toggle = accessory.addService(hap.Service.Switch, "Lamp Switch");

    bulb.getCharacteristic(hap.Characteristic.On).updateValue(true);
    toggle.getCharacteristic(hap.Characteristic.On).updateValue(true);
    bulb.getCharacteristic(hap.Characteristic.Brightness).updateValue(40);
    toggle.getCharacteristic(hap.Characteristic.On).updateValue(false);
    bulb.getCharacteristic(hap.Characteristic.On).updateValue(false);

    assert.deepEqual(accessory.changesOn(bulb).map(({ characteristic, newValue }) => [ characteristic.displayName, newValue ]), [ [ "On", true ],
      [ "Brightness", 40 ], [ "On", false ] ], "naming no characteristic selects every change the service raised, and none another service raised");
    assert.deepEqual(accessory.changesOn(toggle).map(({ newValue }) => newValue), [ true, false ], "and the other service selects its own");
    assert.deepEqual(accessory.changesOn(bulb, hap.Characteristic.On).map(({ newValue }) => newValue), [ true, false ],
      "a named characteristic limits the selection to the service's changes to it, the other service's changes to the same characteristic left out");
    assert.deepEqual(accessory.changesOn(bulb, hap.Characteristic.Brightness, hap.Characteristic.On).map(({ newValue }) => newValue), [ true, 40, false ],
      "several characteristics select in the order HAP raised the changes");
    assert.deepEqual(accessory.changesOn(toggle, hap.Characteristic.Brightness), [], "a characteristic the service never changed selects nothing");
    assert.ok(accessory.changesOn(bulb).every((change) => change.service === bulb), "each entry selected carries the service it was raised on");
  });

  test("clearObservations empties the record of changes and warnings, and the accessory keeps recording", (t) => {

    const writes = consoleWrites(t);
    const api = setup();
    const accessory = accessoryNamed(api, "Lamp");
    const toggle = accessory.addService(hap.Service.Switch, "Lamp Switch");

    toggle.getCharacteristic(hap.Characteristic.On).updateValue(true);
    toggle.getCharacteristic(hap.Characteristic.Brightness);

    assert.equal(accessory.changes.length, 1, "precondition: a change was recorded");
    assert.equal(accessory.warnings.length, 1, "precondition: a warning was recorded");

    accessory.clearObservations();

    assert.equal(accessory.changes.length, 0, "a clear must empty the changes");
    assert.equal(accessory.warnings.length, 0, "and the warnings");

    toggle.getCharacteristic(hap.Characteristic.On).updateValue(false);

    assert.equal(accessory.changes.length, 1, "the record continues after it is cleared");
    assert.equal(writes(), 0);
  });
});

describe("TestPlatformAccessory - warnings", () => {

  test("captures every warning an unregistered accessory raises as it read at capture, with the console silent", async (t) => {

    const writes = consoleWrites(t);
    const api = setup();
    const accessory = accessoryNamed(api, "Lamp");
    const toggle = accessory.addService(hap.Service.Switch, "Lamp Switch");
    const on = toggle.getCharacteristic(hap.Characteristic.On);

    // A characteristic outside the service's catalog draws a warning as HAP adds it anyway, and a get handler's own error draws an error-level one.
    toggle.getCharacteristic(hap.Characteristic.Brightness);
    on.onGet(() => {

      throw new Error("The device dropped the read.");
    });

    await assert.rejects(triggerGet(on), HomeKitRequestError);

    assert.deepEqual(expectAt(accessory.warnings, 0).originatorChain, [ "Lamp", "Lamp Switch", "Brightness" ]);
    assert.deepEqual(accessory.takeWarnings().map((warning) => warning.type), [ CharacteristicWarningType.WARN_MESSAGE, CharacteristicWarningType.ERROR_MESSAGE ]);
    assert.equal(writes(), 0, "a captured warning must never reach the console");
  });

  test("captures a registered accessory's warning once, with the bridge printing nothing and its rewrite of the chain kept out of the record", (t) => {

    const writes = consoleWrites(t);
    const api = setup();
    const accessory = accessoryNamed(api, "Lamp");
    const toggle = accessory.addService(hap.Service.Switch, "Lamp Switch");

    api.registerPlatformAccessories(PLUGIN, PLATFORM, [accessory]);
    toggle.getCharacteristic(hap.Characteristic.Brightness);

    assert.equal(accessory.warnings.length, 1);
    assert.deepEqual(accessory.takeWarnings().map(({ originatorChain, type }) => ({ originatorChain, type })),
      [{ originatorChain: [ "Lamp", "Lamp Switch", "Brightness" ], type: CharacteristicWarningType.WARN_MESSAGE }],
      "the bridge prefixes its own name to the warning it re-raises, after the record has copied the chain");
    assert.equal(writes(), 0, "the bridge must not print the warning it re-raises");
  });

  test("captures a warning after an unregister strips the accessory of its listeners, with the console silent", (t) => {

    const writes = consoleWrites(t);
    const api = setup();
    const accessory = accessoryNamed(api, "Lamp");
    const toggle = accessory.addService(hap.Service.Switch, "Lamp Switch");

    api.registerPlatformAccessories(PLUGIN, PLATFORM, [accessory]);
    api.unregisterPlatformAccessories(PLUGIN, PLATFORM, [accessory]);
    toggle.getCharacteristic(hap.Characteristic.Brightness);

    assert.deepEqual(accessory.takeWarnings().map(({ originatorChain, type }) => ({ originatorChain, type })),
      [{ originatorChain: [ "Lamp", "Lamp Switch", "Brightness" ], type: CharacteristicWarningType.WARN_MESSAGE }]);
    assert.equal(writes(), 0);
  });

  test("an unregister HAP refuses partway still leaves every accessory it stripped capturing its warnings", (t) => {

    const writes = consoleWrites(t);
    const api = setup();
    const accessory = accessoryNamed(api, "Lamp");
    const stranger = accessoryNamed(api, "Stranger");
    const toggle = accessory.addService(hap.Service.Switch, "Lamp Switch");
    const strangerToggle = stranger.addService(hap.Service.Switch, "Stranger Switch");

    api.registerPlatformAccessories(PLUGIN, PLATFORM, [accessory]);

    // The bridge removes the lamp and strips it before it refuses the stranger, which it never held.
    assert.throws(() => api.unregisterPlatformAccessories(PLUGIN, PLATFORM, [ accessory, stranger ]), /Cannot find the bridged Accessory to remove/);
    assert.equal(accessory._associatedHAPAccessory.bridged, false, "precondition: the bridge removed the lamp before refusing");

    toggle.getCharacteristic(hap.Characteristic.Brightness);
    strangerToggle.getCharacteristic(hap.Characteristic.Brightness);

    assert.deepEqual(accessory.takeWarnings().map((warning) => warning.type), [CharacteristicWarningType.WARN_MESSAGE]);
    assert.deepEqual(stranger.takeWarnings().map((warning) => warning.type), [CharacteristicWarningType.WARN_MESSAGE],
      "the stranger kept its listener through the refusal, so hearing it again must not record its warning twice");
    assert.equal(writes(), 0);
  });

  test("an accessory one API made and another unregistered keeps capturing its warnings", (t) => {

    const writes = consoleWrites(t);
    const maker = setup();
    const remover = setup();
    const accessory = accessoryNamed(maker, "Lamp");
    const toggle = accessory.addService(hap.Service.Switch, "Lamp Switch");

    remover.registerPlatformAccessories(PLUGIN, PLATFORM, [accessory]);
    remover.unregisterPlatformAccessories(PLUGIN, PLATFORM, [accessory]);
    toggle.getCharacteristic(hap.Characteristic.Brightness);

    assert.deepEqual(accessory.takeWarnings().map((warning) => warning.type), [CharacteristicWarningType.WARN_MESSAGE],
      "the capture belongs to the accessory, so whichever API stripped it listens again");
    assert.equal(writes(), 0);
  });

  test("takeWarnings answers the record and empties it, and the accessory keeps recording", (t) => {

    const writes = consoleWrites(t);
    const api = setup();
    const accessory = accessoryNamed(api, "Lamp");
    const toggle = accessory.addService(hap.Service.Switch, "Lamp Switch");

    toggle.getCharacteristic(hap.Characteristic.Brightness);

    const recorded = [...accessory.warnings];
    const taken = accessory.takeWarnings();

    assert.deepEqual(recorded.map((warning) => warning.type), [CharacteristicWarningType.WARN_MESSAGE], "precondition: a warn-message warning was recorded");
    assert.deepEqual(taken, recorded, "a take answers the record");
    assert.deepEqual(accessory.warnings, [], "and empties it");
    assert.deepEqual(accessory.takeWarnings(), [], "so a second take answers nothing");

    toggle.getCharacteristic(hap.Characteristic.Hue);

    assert.deepEqual(accessory.takeWarnings().map(({ characteristic, type }) => ({ characteristic: characteristic.displayName, type })),
      [{ characteristic: "Hue", type: CharacteristicWarningType.WARN_MESSAGE }], "the accessory keeps recording, and a later take answers only what it raised since");
    assert.equal(taken.length, 1, "and what an earlier take answered stays the caller's own");
    assert.equal(writes(), 0);
  });
});

describe("triggerGet and triggerSet", () => {

  test("triggerGet answers what the get handler answers through HAP's read path, handing the handler the trigger's connection", async () => {

    const api = setup();
    const accessory = accessoryNamed(api, "Lamp");
    const on = accessory.addService(hap.Service.Lightbulb, "Lamp Bulb").getCharacteristic(hap.Characteristic.On);
    const connections: unknown[] = [];

    on.onGet((_context, connection) => {

      connections.push(connection);

      return true;
    });

    assert.equal(await triggerGet(on), true);
    assert.equal(connections.length, 1, "the read must run the get handler once");
    assert.notEqual(connections[0], undefined, "a triggered read hands the get handler a connection, as a controller's read does");
    assert.equal(expectAt(accessory.changes, 0).originator, connections[0], "and stamps the same connection on the change the read raised");
  });

  test("triggerGet refuses a characteristic without the paired-read permission with WRITE_ONLY_CHARACTERISTIC", async () => {

    const api = setup();
    const information = accessoryNamed(api, "Lamp").getService(hap.Service.AccessoryInformation);
    const identify = information?.getCharacteristic(hap.Characteristic.Identify) ?? assert.fail("the accessory must carry an information service");

    await assert.rejects(triggerGet(identify), hapStatus(HAPStatus.WRITE_ONLY_CHARACTERISTIC));
  });

  test("triggerGet rejects with a handler's HAP status, and with SERVICE_COMMUNICATION_FAILURE and a captured warning for any other error", async (t) => {

    const writes = consoleWrites(t);
    const api = setup();
    const accessory = accessoryNamed(api, "Lamp");
    const bulb = accessory.addService(hap.Service.Lightbulb, "Lamp Bulb");
    const on = bulb.getCharacteristic(hap.Characteristic.On);
    const brightness = bulb.getCharacteristic(hap.Characteristic.Brightness);

    on.onGet(() => {

      throw new hap.HapStatusError(HAPStatus.RESOURCE_BUSY);
    });

    brightness.onGet(() => {

      throw new Error("The device dropped the read.");
    });

    await assert.rejects(triggerGet(on), hapStatus(HAPStatus.RESOURCE_BUSY));

    assert.equal(accessory.warnings.length, 0, "HAP's own status error raises no warning");

    await assert.rejects(triggerGet(brightness), refusedWith({ cause: HAPStatus.SERVICE_COMMUNICATION_FAILURE, handlerFault: true,
      message: "HomeKit's read request was refused with HAP status -70402, because HAP reported a fault while serving it.",
      status: HAPStatus.SERVICE_COMMUNICATION_FAILURE }));

    assert.deepEqual(accessory.takeWarnings().map((warning) => warning.type), [CharacteristicWarningType.ERROR_MESSAGE], "any other error is reported as a warning");
    assert.equal(writes(), 0);
  });

  test("triggerSet refuses a characteristic without the paired-write permission with READ_ONLY_CHARACTERISTIC and never runs the set handler", async () => {

    const api = setup();
    const sensor = accessoryNamed(api, "Sensor").addService(hap.Service.TemperatureSensor, "Sensor");
    const temperature = sensor.getCharacteristic(hap.Characteristic.CurrentTemperature);
    let writes = 0;

    temperature.onSet(() => {

      writes++;
    });

    await assert.rejects(triggerSet(temperature, 21), hapStatus(HAPStatus.READ_ONLY_CHARACTERISTIC));
    assert.equal(writes, 0, "a refused write must never reach the set handler");
  });

  test("triggerSet refuses an invalid value with INVALID_VALUE_IN_REQUEST, as HAP validates a controller's write", async () => {

    const api = setup();
    const accessory = accessoryNamed(api, "Lamp");
    const brightness = accessory.addService(hap.Service.Lightbulb, "Lamp Bulb").getCharacteristic(hap.Characteristic.Brightness);

    await assert.rejects(triggerSet(brightness, 200), hapStatus(HAPStatus.INVALID_VALUE_IN_REQUEST));
    assert.deepEqual(accessory.changes, [], "a refused write must change nothing");
  });

  test("triggerSet runs the set handler with the value and records the write with the trigger's connection as its originator", async () => {

    const api = setup();
    const accessory = accessoryNamed(api, "Lamp");
    const on = accessory.addService(hap.Service.Lightbulb, "Lamp Bulb").getCharacteristic(hap.Characteristic.On);
    const received: unknown[] = [];

    on.onSet((value) => {

      received.push(value);
    });

    await triggerSet(on, true);
    on.updateValue(false);

    assert.deepEqual(received, [true], "the set handler must receive the value HomeKit wrote");

    const write = expectAt(accessory.changes, 0);
    const update = expectAt(accessory.changes, 1);

    assert.equal(write.reason, "write");
    assert.notEqual(write.originator, undefined, "a triggered write carries the trigger's connection as its originator");
    assert.equal(update.originator, undefined, "while a plugin's own update carries none");
  });

  test("triggerSet rejects with a set handler's HAP status", async () => {

    const api = setup();
    const on = accessoryNamed(api, "Lamp").addService(hap.Service.Lightbulb, "Lamp Bulb").getCharacteristic(hap.Characteristic.On);

    on.onSet(() => {

      throw new hap.HapStatusError(HAPStatus.RESOURCE_BUSY);
    });

    await assert.rejects(triggerSet(on, true), hapStatus(HAPStatus.RESOURCE_BUSY));
  });

  test("every refusal is a HomeKitRequestError naming the request and HAP's status in a sentence, with HAP's own rejection as its cause", async (t) => {

    const writes = consoleWrites(t);
    const api = setup();
    const accessory = accessoryNamed(api, "Lamp");
    const bulb = accessory.addService(hap.Service.Lightbulb, "Lamp Bulb");
    const on = bulb.getCharacteristic(hap.Characteristic.On);
    const brightness = bulb.getCharacteristic(hap.Characteristic.Brightness);
    const identify = accessory.getService(hap.Service.AccessoryInformation)?.getCharacteristic(hap.Characteristic.Identify) ??
      assert.fail("the accessory must carry an information service");
    const temperature = accessoryNamed(api, "Sensor").addService(hap.Service.TemperatureSensor, "Sensor").getCharacteristic(hap.Characteristic.CurrentTemperature);

    on.onGet(() => {

      throw new hap.HapStatusError(HAPStatus.RESOURCE_BUSY);
    });

    on.onSet(() => {

      throw new hap.HapStatusError(HAPStatus.RESOURCE_BUSY);
    });

    brightness.onGet(() => {

      throw new Error("The device dropped the read.");
    });

    await assert.rejects(triggerGet(identify), refusedWith({ cause: HAPStatus.WRITE_ONLY_CHARACTERISTIC,
      message: "HomeKit's read request was refused with HAP status -70405.", status: HAPStatus.WRITE_ONLY_CHARACTERISTIC }));
    await assert.rejects(triggerGet(on), refusedWith({ cause: HAPStatus.RESOURCE_BUSY,
      message: "HomeKit's read request was refused with HAP status -70403.", status: HAPStatus.RESOURCE_BUSY }));
    await assert.rejects(triggerGet(brightness), refusedWith({ cause: HAPStatus.SERVICE_COMMUNICATION_FAILURE, handlerFault: true,
      message: "HomeKit's read request was refused with HAP status -70402, because HAP reported a fault while serving it.",
      status: HAPStatus.SERVICE_COMMUNICATION_FAILURE }));
    await assert.rejects(triggerSet(temperature, 21), refusedWith({ message: "HomeKit's write request was refused with HAP status -70404.",
      status: HAPStatus.READ_ONLY_CHARACTERISTIC }));
    await assert.rejects(triggerSet(brightness, 200), refusedWith({ cause: HAPStatus.INVALID_VALUE_IN_REQUEST,
      message: "HomeKit's write request was refused with HAP status -70410.", status: HAPStatus.INVALID_VALUE_IN_REQUEST }));
    await assert.rejects(triggerSet(on, true), refusedWith({ cause: HAPStatus.RESOURCE_BUSY,
      message: "HomeKit's write request was refused with HAP status -70403.", status: HAPStatus.RESOURCE_BUSY }));

    assert.deepEqual(accessory.takeWarnings().map((warning) => warning.type), [CharacteristicWarningType.ERROR_MESSAGE],
      "the crashed read is the one refusal HAP warned of");
    assert.equal(writes(), 0);
  });

  test("triggerGet and triggerSet pass a rejection that is not a HAP status through unchanged", async (t) => {

    // HAP's request paths reject only with a status number, so the row stands a failing request path in for HAP's to reach the pass-through.
    const api = setup();
    const on = accessoryNamed(api, "Lamp").addService(hap.Service.Lightbulb, "Lamp Bulb").getCharacteristic(hap.Characteristic.On);
    const failure = new Error("The request path failed.");

    t.mock.method(on, "handleGetRequest", async (): Promise<never> => {

      throw failure;
    });

    t.mock.method(on, "handleSetRequest", async (): Promise<never> => {

      throw failure;
    });

    await assert.rejects(triggerGet(on), (rejection: unknown): boolean => rejection === failure);
    await assert.rejects(triggerSet(on, true), (rejection: unknown): boolean => rejection === failure);
  });

  test("a handler's foreign throw marks the refusal of a read and of a write a handler fault, and hapStatus fails on it at the status it carries", async (t) => {

    const writes = consoleWrites(t);
    const api = setup();
    const accessory = accessoryNamed(api, "Lamp");
    const on = accessory.addService(hap.Service.Lightbulb, "Lamp Bulb").getCharacteristic(hap.Characteristic.On);

    on.onGet(() => {

      throw new Error("The device dropped the read.");
    });

    on.onSet(() => {

      throw new Error("The device dropped the write.");
    });

    await assert.rejects(triggerGet(on), refusedWith({ cause: HAPStatus.SERVICE_COMMUNICATION_FAILURE, handlerFault: true,
      message: "HomeKit's read request was refused with HAP status -70402, because HAP reported a fault while serving it.",
      status: HAPStatus.SERVICE_COMMUNICATION_FAILURE }));
    await assert.rejects(triggerSet(on, true), refusedWith({ cause: HAPStatus.SERVICE_COMMUNICATION_FAILURE, handlerFault: true,
      message: "HomeKit's write request was refused with HAP status -70402, because HAP reported a fault while serving it.",
      status: HAPStatus.SERVICE_COMMUNICATION_FAILURE }));

    // HAP answers the crash with the very status a Not Responding refusal carries, so the matcher a suite asserts that refusal with is what has to fail.
    await assert.rejects(assert.rejects(triggerGet(on), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE)), { message: FAULT_SENTENCE });
    await assert.rejects(assert.rejects(triggerSet(on, true), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE)), { message: FAULT_SENTENCE });

    assert.deepEqual(accessory.takeWarnings().map((warning) => warning.type), [ CharacteristicWarningType.ERROR_MESSAGE, CharacteristicWarningType.ERROR_MESSAGE,
      CharacteristicWarningType.ERROR_MESSAGE, CharacteristicWarningType.ERROR_MESSAGE ], "HAP warned of the crash inside each request");
    assert.equal(writes(), 0);
  });

  test("a value HAP cannot accept from a get handler marks the refusal a handler fault on its warn-level warning, and hapStatus fails on it", async (t) => {

    // Product Data is a data-format characteristic, the one format whose validation refuses a value outright rather than coercing it, so a number from the read
    // handler reaches HomeKit as HAP's generic failure, reported by a warn-level warning alone.
    const writes = consoleWrites(t);
    const api = setup();
    const accessory = accessoryNamed(api, "Lamp");
    const productData = accessory.getService(hap.Service.AccessoryInformation)?.getCharacteristic(hap.Characteristic.ProductData) ??
      assert.fail("the accessory must carry an information service");

    productData.onGet(() => 42);

    await assert.rejects(triggerGet(productData), refusedWith({ cause: HAPStatus.SERVICE_COMMUNICATION_FAILURE, handlerFault: true,
      message: "HomeKit's read request was refused with HAP status -70402, because HAP reported a fault while serving it.",
      status: HAPStatus.SERVICE_COMMUNICATION_FAILURE }));
    await assert.rejects(assert.rejects(triggerGet(productData), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE)), { message: FAULT_SENTENCE });

    assert.deepEqual(accessory.takeWarnings().map((warning) => warning.type), [ CharacteristicWarningType.WARN_MESSAGE, CharacteristicWarningType.WARN_MESSAGE ],
      "precondition: HAP warned inside each request");
    assert.equal(writes(), 0);
  });

  test("HAP's own status error at the default status leaves the refusal deliberate, and HAP's warning of a legacy listener beside the handler marks it a handler " +
    "fault hapStatus fails on", async (t) => {

    const writes = consoleWrites(t);
    const api = setup();
    const accessory = accessoryNamed(api, "Lamp");
    const on = accessory.addService(hap.Service.Lightbulb, "Lamp Bulb").getCharacteristic(hap.Characteristic.On);

    on.onGet(() => {

      throw new hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    });

    on.onSet(() => {

      throw new hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    });

    await assert.rejects(triggerGet(on), refusedWith({ cause: HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      message: "HomeKit's read request was refused with HAP status -70402.", status: HAPStatus.SERVICE_COMMUNICATION_FAILURE }));
    await assert.rejects(triggerSet(on, true), refusedWith({ cause: HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      message: "HomeKit's write request was refused with HAP status -70402.", status: HAPStatus.SERVICE_COMMUNICATION_FAILURE }));
    await assert.rejects(triggerGet(on), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE));
    await assert.rejects(triggerSet(on, true), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE));

    assert.equal(accessory.warnings.length, 0, "precondition: the deliberate refusals raised no warning");

    // A legacy listener beside the handler is a plugin defect HAP warns of inside the request, before the handler refuses, so the refusal reads as a fault.
    on.on("get", (callback) => {

      callback(null, true);
    });

    await assert.rejects(triggerGet(on), refusedWith({ cause: HAPStatus.SERVICE_COMMUNICATION_FAILURE, handlerFault: true,
      message: "HomeKit's read request was refused with HAP status -70402, because HAP reported a fault while serving it.",
      status: HAPStatus.SERVICE_COMMUNICATION_FAILURE }));
    await assert.rejects(assert.rejects(triggerGet(on), hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE)), { message: FAULT_SENTENCE });

    assert.deepEqual(accessory.takeWarnings().map((warning) => warning.type), [ CharacteristicWarningType.WARN_MESSAGE, CharacteristicWarningType.WARN_MESSAGE ],
      "precondition: HAP warned inside each request");
    assert.equal(writes(), 0);
  });

  test("a warning HAP raises inside a request refused at a status other than SERVICE_COMMUNICATION_FAILURE leaves the refusal deliberate", async (t) => {

    // HAP answers every handler fault with SERVICE_COMMUNICATION_FAILURE, so a refusal at any other status is the handler's own choice, a warning beside it or not.
    const writes = consoleWrites(t);
    const api = setup();
    const accessory = accessoryNamed(api, "Lamp");
    const on = accessory.addService(hap.Service.Lightbulb, "Lamp Bulb").getCharacteristic(hap.Characteristic.On);

    on.onGet(() => {

      throw new hap.HapStatusError(HAPStatus.RESOURCE_BUSY);
    });

    on.on("get", (callback) => {

      callback(null, true);
    });

    await assert.rejects(triggerGet(on), refusedWith({ cause: HAPStatus.RESOURCE_BUSY, message: "HomeKit's read request was refused with HAP status -70403.",
      status: HAPStatus.RESOURCE_BUSY }));
    await assert.rejects(triggerGet(on), hapStatus(HAPStatus.RESOURCE_BUSY));

    assert.deepEqual(accessory.takeWarnings().map((warning) => warning.type), [ CharacteristicWarningType.WARN_MESSAGE, CharacteristicWarningType.WARN_MESSAGE ],
      "precondition: HAP warned inside each request");
    assert.equal(writes(), 0);
  });

  test("a deliberate status number handed to a legacy listener's callback leaves the refusal deliberate at the status a crash carries", async () => {

    const api = setup();
    const on = accessoryNamed(api, "Lamp").addService(hap.Service.Lightbulb, "Lamp Bulb").getCharacteristic(hap.Characteristic.On);

    on.on("get", (callback) => {

      callback(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    });

    on.on("set", (_value, callback) => {

      callback(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    });

    await assert.rejects(triggerGet(on), refusedWith({ cause: HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      message: "HomeKit's read request was refused with HAP status -70402.", status: HAPStatus.SERVICE_COMMUNICATION_FAILURE }));
    await assert.rejects(triggerSet(on, true), refusedWith({ cause: HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      message: "HomeKit's write request was refused with HAP status -70402.", status: HAPStatus.SERVICE_COMMUNICATION_FAILURE }));
  });

  test("a trigger hears the characteristic's warnings only while its request runs, and takes its listener off however the request ends", async (t) => {

    const writes = consoleWrites(t);
    const api = setup();
    const accessory = accessoryNamed(api, "Lamp");
    const on = accessory.addService(hap.Service.Lightbulb, "Lamp Bulb").getCharacteristic(hap.Characteristic.On);
    const before = on.listenerCount("characteristic-warning");
    const during: number[] = [];

    on.onGet(() => {

      during.push(on.listenerCount("characteristic-warning"));

      return true;
    });

    on.onSet(() => undefined);

    await triggerGet(on);

    assert.deepEqual(during, [before + 1], "the trigger's listener is on the characteristic while the handler runs");
    assert.equal(on.listenerCount("characteristic-warning"), before, "and off it once the read answers");

    await triggerSet(on, true);

    assert.equal(on.listenerCount("characteristic-warning"), before, "and once the write answers");

    on.onGet(() => {

      throw new hap.HapStatusError(HAPStatus.RESOURCE_BUSY);
    });

    await assert.rejects(triggerGet(on), hapStatus(HAPStatus.RESOURCE_BUSY));

    assert.equal(on.listenerCount("characteristic-warning"), before, "and once a deliberate refusal settles");

    on.onGet(() => {

      throw new Error("The device dropped the read.");
    });

    await assert.rejects(triggerGet(on), HomeKitRequestError);

    assert.equal(on.listenerCount("characteristic-warning"), before, "and once a crash's refusal settles");
    assert.deepEqual(accessory.takeWarnings().map((warning) => warning.type), [CharacteristicWarningType.ERROR_MESSAGE], "the crash is the one request HAP warned of");
    assert.equal(writes(), 0);
  });
});

describe("hapStatus", () => {

  test("accepts a rejection carrying its status and answers true", () => {

    const validate = hapStatus(HAPStatus.RESOURCE_BUSY);

    assert.equal(validate(new HomeKitRequestError("read", HAPStatus.RESOURCE_BUSY)), true, "a trigger's refusal carries the status");
    assert.equal(validate(new hap.HapStatusError(HAPStatus.RESOURCE_BUSY)), true, "and so does the status error a directly called handler throws");
  });

  test("fails when a trigger's refusal, a directly called handler's status error or any other Error carries another status", () => {

    const validate = hapStatus(HAPStatus.RESOURCE_BUSY);

    assert.throws(() => validate(new HomeKitRequestError("write", HAPStatus.SERVICE_COMMUNICATION_FAILURE)), assert.AssertionError);
    assert.throws(() => validate(new hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE)), assert.AssertionError);
    assert.throws(() => validate(Object.assign(new Error("The device is busy elsewhere."), { hapStatus: HAPStatus.SERVICE_COMMUNICATION_FAILURE })),
      assert.AssertionError, "an Error of any class carrying another status fails");
  });

  test("fails on the bare status number HAP's request paths reject with, on an Error carrying no status, and on a status carried by anything but an Error", () => {

    const validate = hapStatus(HAPStatus.RESOURCE_BUSY);

    assert.throws(() => validate(HAPStatus.RESOURCE_BUSY), { message: "The rejection must be an Error carrying a HAP status." });
    assert.throws(() => validate(new Error("The device is busy.")), { message: "The rejection must be an Error carrying a HAP status." });
    assert.throws(() => validate({ hapStatus: HAPStatus.RESOURCE_BUSY }), { message: "The rejection must be an Error carrying a HAP status." });
  });

  test("fails on a refusal marked a handler fault with a sentence naming the fault, before it compares the status", () => {

    const fault = new HomeKitRequestError("read", HAPStatus.SERVICE_COMMUNICATION_FAILURE, { handlerFault: true });
    const refusal = new HomeKitRequestError("read", HAPStatus.SERVICE_COMMUNICATION_FAILURE);

    assert.equal(fault.handlerFault, true);
    assert.equal(fault.message, "HomeKit's read request was refused with HAP status -70402, because HAP reported a fault while serving it.");
    assert.equal(refusal.handlerFault, false, "a refusal constructed without the option is deliberate");
    assert.throws(() => hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE)(fault), { message: FAULT_SENTENCE }, "a fault fails at the status it carries");
    assert.throws(() => hapStatus(HAPStatus.RESOURCE_BUSY)(fault), { message: FAULT_SENTENCE }, "and the fault is named before any status comparison");
    assert.equal(hapStatus(HAPStatus.SERVICE_COMMUNICATION_FAILURE)(refusal), true, "while the deliberate refusal at that status passes");
  });
});

describe("hasGetHandler and hasSetHandler", () => {

  test("each answers false on a characteristic without a handler, true once onGet or onSet installs one, and false again once it is removed", () => {

    const api = setup();
    const on = accessoryNamed(api, "Lamp").addService(hap.Service.Lightbulb, "Lamp Bulb").getCharacteristic(hap.Characteristic.On);

    assert.equal(hasGetHandler(on), false, "a bare characteristic has no get handler");
    assert.equal(hasSetHandler(on), false, "and no set handler");

    on.onGet(() => true);

    assert.equal(hasGetHandler(on), true, "onGet installs a get handler");
    assert.equal(hasSetHandler(on), false, "and leaves the write path without one");

    on.onSet(() => undefined);

    assert.equal(hasSetHandler(on), true, "onSet installs a set handler");

    on.removeOnGet().removeOnSet();

    assert.equal(hasGetHandler(on), false, "removing the get handler leaves none");
    assert.equal(hasSetHandler(on), false, "and so does removing the set handler");
  });

  test("each answers true for a legacy get or set listener, which HAP's request paths call when no handler is installed", async () => {

    const api = setup();
    const on = accessoryNamed(api, "Lamp").addService(hap.Service.Lightbulb, "Lamp Bulb").getCharacteristic(hap.Characteristic.On);
    const heard: string[] = [];

    on.on("get", (callback) => {

      heard.push("get");
      callback(null, true);
    });

    assert.equal(hasGetHandler(on), true, "a legacy get listener is plugin code the read path calls");
    assert.equal(hasSetHandler(on), false, "and gives the write path none, so each accessor counts only its own listener");

    on.on("set", (_value, callback) => {

      heard.push("set");
      callback();
    });

    assert.equal(hasSetHandler(on), true, "a legacy set listener is plugin code the write path calls");
    assert.equal(await triggerGet(on), true, "HAP's read path answers what the legacy get listener answers");

    await triggerSet(on, false);

    assert.deepEqual(heard, [ "get", "set" ], "HAP's request paths called each listener once");
  });
});

describe("the testing entry point and process lifetime", () => {

  test("importing the testing entry point loads no Homebridge or hap-nodejs module, and loadHomebridge loads them", async () => {

    /* The child lists every module it resolves through a resolve hook, and every CommonJS module in the require cache, then reads the list for paths under
     * hap-nodejs or Homebridge's dist directory before and after loadHomebridge. The reading after it is the control: it shows the instrument sees the very
     * modules the reading before it must not find. The child counts the process's exit listeners the same way, before and after the import, and once more after
     * it builds an API double, whose first construction registers the listener that removes the cache folders, which shows the count sees that listener.
     */
    const outcome = await runChild({ source: [

      "import { createRequire, registerHooks } from 'node:module';",
      "const resolved = [];",
      "registerHooks({ resolve: (specifier, context, nextResolve) => {",
      "  const result = nextResolve(specifier, context);",
      "  resolved.push(result.url);",
      "  return result;",
      "} });",
      "const watched = (location) => location.includes('/@homebridge/hap-nodejs/') || location.includes('/homebridge/dist/');",
      "const loaded = () => [ ...resolved, ...Object.keys(createRequire(" + JSON.stringify(INDEX_URL) + ").cache) ].filter(watched);",
      "const exitBefore = process.listenerCount('exit');",
      "const kit = await import(" + JSON.stringify(INDEX_URL) + ");",
      "const before = loaded();",
      "const exitAfterImport = process.listenerCount('exit');",
      "const runtime = await kit.loadHomebridge(" + JSON.stringify(INDEX_URL) + ");",
      "const after = loaded();",
      "new kit.TestHomebridgeApi(runtime);",
      "const exitListeners = { afterDouble: process.listenerCount('exit'), afterImport: exitAfterImport, before: exitBefore };",
      "process.stdout.write(JSON.stringify({ after, before, exitListeners }));"
    ].join("\n") });

    assert.equal(outcome.code, 0, outcome.stderr);

    const { after, before, exitListeners } = JSON.parse(outcome.stdout) as { after: string[]; before: string[];
      exitListeners: { afterDouble: number; afterImport: number; before: number }; };

    assert.deepEqual(before, [], "importing the testing entry point must load no Homebridge or hap-nodejs module");
    assert.ok(after.some((location) => location.includes("/@homebridge/hap-nodejs/")), "the instrument must see the hap-nodejs copy loadHomebridge requires");
    assert.ok(after.some((location) => location.endsWith("/homebridge/dist/platformAccessory.js")), "and Homebridge's PlatformAccessory module it imports");
    assert.equal(exitListeners.afterImport, exitListeners.before, "importing the testing entry point must register no exit listener");
    assert.equal(exitListeners.afterDouble, exitListeners.before + 1, "the count must see the exit listener the first API double registers");
  });

  test("the first API double a process builds, over a Homebridge API that warns while it is built, throws Homebridge's warning quoting the line and prints nothing",
    async () => {

      /* Only a process's first API double meets Homebridge's logger unrouted, because the first double routes it for the rest of the process and this suite built
       * its own long before this row, so the double is built in a child, over an API that warns as it is built, with the console's writers counting every write.
       */
      const outcome = await runChild({ source: [

        "const kit = await import(" + JSON.stringify(INDEX_URL) + ");",
        "const runtime = await kit.loadHomebridge(" + JSON.stringify(INDEX_URL) + ");",
        "const warning = " + JSON.stringify("Homebridge's API could not read its configuration:") + ";",
        "let writes = 0;",
        "for(const method of [ 'error', 'log', 'warn' ]) { console[method] = () => { writes++; }; }",
        "class WarningApi extends runtime.HomebridgeAPI {",
        "  constructor() { super(); runtime.Logger.internal.warn(warning, 'the file is missing.'); }",
        "}",
        "let thrown = null;",
        "try { new kit.TestHomebridgeApi({ ...runtime, HomebridgeAPI: WarningApi }); } catch(error) { thrown = error; }",
        "process.stdout.write(JSON.stringify({ lines: thrown?.lines ?? null, name: thrown?.name ?? null, writes }));"
      ].join("\n") });

      assert.equal(outcome.code, 0, outcome.stderr);
      assert.deepEqual(JSON.parse(outcome.stdout), { lines: [{ level: "warn", message: "Homebridge's API could not read its configuration: the file is missing." }],
        name: "HomebridgeServerWarning", writes: 0 }, "the construction must throw Homebridge's warning quoting the line, with nothing printed");
    });

  test("a process that builds, registers and drives accessories exits on its own", async () => {

    const outcome = await runChild({ source: [

      "const kit = await import(" + JSON.stringify(INDEX_URL) + ");",
      "const runtime = await kit.loadHomebridge(" + JSON.stringify(INDEX_URL) + ");",
      "const { hap } = runtime;",
      "const api = new kit.TestHomebridgeApi(runtime);",
      "const accessory = (name) => new api.platformAccessory(name, hap.uuid.generate('lifetime.' + name));",
      "const lamp = accessory('Lamp');",
      "const on = lamp.addService(hap.Service.Lightbulb, 'Lamp').getCharacteristic(hap.Characteristic.On);",
      "on.onGet(() => true).onSet(() => undefined);",
      "api.registerPlatformAccessories('homebridge-test', 'TestPlatform', [lamp]);",
      "await kit.triggerSet(on, false);",
      "await kit.triggerGet(on);",
      "on.updateValue(false);",
      "api.updatePlatformAccessories([lamp]);",
      "api.unregisterPlatformAccessories('homebridge-test', 'TestPlatform', [lamp]);",
      "api.restorePlatformAccessories({ accessories: [accessory('Restored')], platform: { configureAccessory: () => undefined }, platformName: 'TestPlatform',",
      "  pluginIdentifier: 'homebridge-test' });",
      "api.publishExternalAccessories('homebridge-test', [accessory('External')]);",
      "process.stdout.write(JSON.stringify({ changes: lamp.changes.length }));"
    ].join("\n") });

    assert.equal(outcome.code, 0, "the child must reach its own exit inside the deadline: " + outcome.stderr);
    assert.deepEqual(JSON.parse(outcome.stdout), { changes: 3 }, "the child must have driven the accessory: a write, a read that changed the value, and an update");
  });

  test("a process that builds API doubles, registers and restores through them exits on its own, successfully, and removes every temporary cache folder they made",
    async () => {

      /* The child runs with a temp folder of the row's own and lists what appeared in it once its API doubles are built and used, which is what the row reads after
       * the child has exited. The listing is the control: it shows the folders the exit must remove existed while the child ran.
       */
      await using root = await makeScratchRoot(SCRATCH_PREFIX);

      const outcome = await runChild({ env: { TMPDIR: root.path }, source: [

        "import { readdirSync } from 'node:fs';",
        "import { tmpdir } from 'node:os';",
        "const kit = await import(" + JSON.stringify(INDEX_URL) + ");",
        "const runtime = await kit.loadHomebridge(" + JSON.stringify(INDEX_URL) + ");",
        "const before = readdirSync(tmpdir());",
        "const api = new kit.TestHomebridgeApi(runtime);",
        "const restoring = new kit.TestHomebridgeApi(runtime);",
        "const accessory = (made, name) => new made.platformAccessory(name, runtime.hap.uuid.generate('folders.' + name));",
        "api.registerPlatformAccessories('homebridge-test', 'TestPlatform', [accessory(api, 'Lamp')]);",
        "restoring.restorePlatformAccessories({ accessories: [accessory(restoring, 'Restored')], platform: { configureAccessory: () => undefined },",
        "  platformName: 'TestPlatform', pluginIdentifier: 'homebridge-test' });",
        "process.stdout.write(JSON.stringify(readdirSync(tmpdir()).filter((name) => !before.includes(name))));"
      ].join("\n") });

      assert.equal(outcome.code, 0, "the child must reach its own exit inside the deadline: " + outcome.stderr);

      const made = JSON.parse(outcome.stdout) as string[];

      assert.equal(made.length, 2, "precondition: each API double made its cache folder under the temp folder the child was handed");
      assert.deepEqual((await readdir(root.path)).filter((name) => made.includes(name)), [], "the child's exit must remove every folder its API doubles made");
    });
});

/* Compile-time exercises for serverLog's type, which never run - the function is never called, and its leading underscore marks it as a compile-time exercise the
 * typecheck reads. Each case uses `@ts-expect-error`, which fails the typecheck if the error it expects ever stops occurring, so a serverLog a suite could shorten,
 * extend or replace under the held set's cursor fails the build here.
 */
const _serverLogExercises = (api: TestHomebridgeApi): void => {

  // @ts-expect-error - a suite cannot shorten serverLog, which would leave the warnings Homebridge logs after it unheld.
  api.serverLog.length = 0;

  // @ts-expect-error - nor write a line no call logged.
  api.serverLog[0] = { level: "warn", message: "A line no call logged." };

  // @ts-expect-error - nor replace the log the frames write.
  api.serverLog = [];
};
