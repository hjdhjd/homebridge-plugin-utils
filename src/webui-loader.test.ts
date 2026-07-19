/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webui-loader.test.ts: Unit tests for the webUI boot-region stamp - config parsing, region rendering, and the boot monitor's on-page failure behavior.
 */
import { WEBUI_LOADER_BEGIN, WEBUI_LOADER_END, parseWebUiLoaderConfig, renderWebUiBootRegion } from "./webui-loader.ts";
import { createFakeHomebridge, createTestDom, installHomebridge } from "../ui/ui.helpers.mjs";
import { describe, test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { runInThisContext } from "node:vm";

// A well-formed config comment placed outside a marker pair, the shape a plugin's index.html carries. Built as a helper so each test varies only the config JSON it
// cares about while the surrounding markers stay constant.
function htmlWith(configJson: string): string {

  return "<html>\n<!-- WEBUI LOADER CONFIG " + configJson + " -->\n" + WEBUI_LOADER_BEGIN + "\n" + WEBUI_LOADER_END + "\n</html>";
}

describe("parseWebUiLoaderConfig", () => {

  test("parses a valid config into its entry and bust list", () => {

    const config = parseWebUiLoaderConfig(htmlWith("{\"bust\":[\"./protect-config.mjs\"],\"entry\":\"./ui.mjs\"}"), "index.html");

    assert.equal(config.entry, "./ui.mjs");
    assert.deepEqual(config.bust, ["./protect-config.mjs"]);
  });

  test("defaults an absent bust list to an empty array", () => {

    const config = parseWebUiLoaderConfig(htmlWith("{\"entry\":\"./ui.mjs\"}"), "index.html");

    assert.equal(config.entry, "./ui.mjs");
    assert.deepEqual(config.bust, [], "an omitted bust field is treated as no extra cache-busts");
  });

  test("throws a framed error naming the file when no config comment is present", () => {

    assert.throws(() => parseWebUiLoaderConfig("<html>" + WEBUI_LOADER_BEGIN + WEBUI_LOADER_END + "</html>", "plugin/index.html"),
      /no `<!-- WEBUI LOADER CONFIG \.\.\. -->` comment found in plugin\/index\.html/);
  });

  test("throws a framed ambiguity error when the config comment is duplicated", () => {

    const html = "<html>\n<!-- WEBUI LOADER CONFIG {\"entry\":\"./ui.mjs\"} -->\n<!-- WEBUI LOADER CONFIG {\"entry\":\"./other.mjs\"} -->\n" + WEBUI_LOADER_BEGIN +
      WEBUI_LOADER_END + "</html>";

    assert.throws(() => parseWebUiLoaderConfig(html, "index.html"), /multiple `WEBUI LOADER CONFIG` comments found in index\.html; the loader config is ambiguous/);
  });

  test("throws a framed error when the config comment is not terminated", () => {

    // No comment terminator anywhere after the config prefix, so the parse cannot find the JSON's end. The markers are omitted deliberately: a BEGIN marker after the
    // prefix would supply a terminator of its own and route this into the invalid-JSON rejection instead.
    const html = "<html>\n<!-- WEBUI LOADER CONFIG {\"entry\":\"./ui.mjs\"}\n</html>";

    assert.throws(() => parseWebUiLoaderConfig(html, "index.html"), /`WEBUI LOADER CONFIG` comment in index\.html is not terminated/);
  });

  test("throws a framed error when the config JSON is invalid", () => {

    assert.throws(() => parseWebUiLoaderConfig(htmlWith("{not valid json}"), "index.html"), /`WEBUI LOADER CONFIG` comment in index\.html is not valid JSON/);
  });

  test("throws a framed error when the entry field is missing or not a string", () => {

    assert.throws(() => parseWebUiLoaderConfig(htmlWith("{\"bust\":[\"./x.mjs\"]}"), "index.html"), /must carry an `entry` string/);
    assert.throws(() => parseWebUiLoaderConfig(htmlWith("{\"entry\":42}"), "index.html"), /must carry an `entry` string/);
  });

  test("throws a framed error when the bust field is not an array of strings", () => {

    const notArray = "{\"bust\":\"./x.mjs\",\"entry\":\"./ui.mjs\"}";
    const notStrings = "{\"bust\":[1,2],\"entry\":\"./ui.mjs\"}";

    assert.throws(() => parseWebUiLoaderConfig(htmlWith(notArray), "index.html"), /`bust` field in index\.html must be an array of strings/);
    assert.throws(() => parseWebUiLoaderConfig(htmlWith(notStrings), "index.html"), /`bust` field in index\.html must be an array of strings/);
  });

  test("throws a framed error when the config comment sits inside the marked region", () => {

    // The config comment is between the BEGIN and END markers, where the first stamp would erase it.
    const html = "<html>\n" + WEBUI_LOADER_BEGIN + "\n<!-- WEBUI LOADER CONFIG {\"entry\":\"./ui.mjs\"} -->\n" + WEBUI_LOADER_END + "\n</html>";

    assert.throws(() => parseWebUiLoaderConfig(html, "index.html"), /sits inside the marked region in index\.html; move it outside the marker pair/);
  });
});

// The rendered region for a representative config, shared by the render-form assertions and the monitor-behavior harness below. Its inputs match a real plugin's
// config so the extracted panel markup and monitor script are exactly what a stamped index.html carries.
const region = renderWebUiBootRegion({ bust: ["./protect-config.mjs"], entry: "./ui.mjs", libPath: "./lib/", packageName: "homebridge-plugin-utils" });

// The status-panel markup is everything before the first script tag; the classic monitor is the `<script>` that carries no attributes (the module loader is
// `<script type="module">`, so a bare `<script>` search never catches it). Both are lifted from the rendered region so the tests exercise the real emitted text
// rather than a hand-rolled shim.
const MONITOR_OPEN = "<script>\n";
const panelMarkup = region.slice(0, region.indexOf("<script>"));
const monitorStart = region.indexOf(MONITOR_OPEN) + MONITOR_OPEN.length;
const monitorSource = region.slice(monitorStart, region.indexOf("</script>", monitorStart));

// The two methods the monitor freezes onto `window.webUiBoot`. Declared so the tests reach the registered monitor with types rather than `any`.
interface BootMonitor {

  fail(stage: string, error: unknown): void;
  ready(): void;
}

// Read the monitor the classic script registered on the current window. In a browser `window` and `globalThis` coincide; in the Happy-DOM harness the monitor's
// `window.webUiBoot` assignment lands on the installed window, so tests read it here rather than off `globalThis`.
function rawBootMonitor(): BootMonitor | undefined {

  return (window as typeof window & { webUiBoot?: BootMonitor }).webUiBoot;
}

// The registered monitor, asserting it exists so call sites stay flat.
function bootMonitor(): BootMonitor {

  const monitor = rawBootMonitor();

  assert.ok(monitor, "the monitor must register window.webUiBoot");

  return monitor;
}

// A fake homebridge bridge whose hideSpinner is a call counter, so a test can assert the monitor dropped the host spinner. createFakeHomebridge types loosely as
// `Object`, so we narrow to the one method the monitor touches before overriding it.
function spinnerSpyHomebridge(): { calls: { hideSpinner: number }; fake: { hideSpinner: () => void } } {

  const fake = createFakeHomebridge() as { hideSpinner: () => void };
  const calls = { hideSpinner: 0 };

  fake.hideSpinner = (): void => {

    calls.hideSpinner += 1;
  };

  return { calls, fake };
}

// Bring the monitor to life against the current test DOM: enable the mock timer clock the watchdog arms against, mount the extracted panel markup, and execute the
// extracted classic monitor script. The caller owns `using dom = createTestDom()` and the homebridge install so their disposal runs on the test's scope.
function startMonitor(t: TestContext): void {

  t.mock.timers.enable({ apis: ["setTimeout"] });
  document.body.innerHTML = panelMarkup;
  runInThisContext(monitorSource);
}

// The display of the one pre-rendered bucket message, looked up the way the monitor selects it.
function bucketDisplay(bucket: string): string {

  const element = document.querySelector<HTMLElement>("#bootErrorMessage [data-boot-bucket='" + bucket + "']");

  assert.ok(element, "the panel must carry the " + bucket + " message");

  return element.style.display;
}

// The display of a panel element by id.
function displayOf(id: string): string {

  const element = document.getElementById(id);

  assert.ok(element, "the panel must carry a #" + id + " element");

  return element.style.display;
}

describe("renderWebUiBootRegion", () => {

  test("busts the ENTRY module itself: its importmap key is the bare path and its value is the bust() call, not an identity mapping", () => {

    // The entry sits outside the package's hashed versioning, so an unbusted entry (an identity mapping) would regress the cache-bust of the most important module. The
    // bare-key-with-bust()-value form is what a bare name-presence check would miss.
    assert.match(region, /"\.\/ui\.mjs": bust\("\.\/ui\.mjs"\)/, "the entry module maps its bare key to a bust() call");
    assert.doesNotMatch(region, /"\.\/ui\.mjs": "\.\/ui\.mjs"/, "the entry must not be an unbusted identity mapping");
  });

  test("busts each declared bust entry: bare key, bust() value", () => {

    assert.match(region, /"\.\/protect-config\.mjs": bust\("\.\/protect-config\.mjs"\)/, "the bust entry maps its bare key to a bust() call");
  });

  test("the bust() helper appends the shared ?cb= cache-bust parameter", () => {

    assert.match(region, /const bust = \(path\) => new URL\(path, import\.meta\.url\)\.href \+ "\?cb=" \+ cb;/, "bust() resolves against import.meta.url + ?cb=");
    assert.match(region, /const cb = Date\.now\(\);/, "a single Date.now() stamp is shared across the page load");
  });

  test("the trailing-slash prefix entry maps a SYNTHETIC packageName - not a hardcoded literal - to the hashed subdir", () => {

    // A synthetic package name distinct from the real one: a hardcoded-literal implementation that emitted "homebridge-plugin-utils/" would fail this.
    const withSyntheticName = renderWebUiBootRegion({ bust: [], entry: "./ui.mjs", libPath: "./lib/", packageName: "acme-plugin-name" });

    assert.match(withSyntheticName, /"acme-plugin-name\/": new URL\("\.\/lib\/" \+ manifest\.subdir \+ "\/", import\.meta\.url\)\.href/,
      "the prefix key is the supplied package name, mapped to the hashed subdir");
    assert.doesNotMatch(withSyntheticName, /"homebridge-plugin-utils\/":/, "no hardcoded package-name prefix key may leak into the importmap");
  });

  test("libPath drives both the manifest fetch and the prefix URL - not a hardcoded ./lib/", () => {

    // A distinct libPath: a hardcoded "./lib/" that ignored the argument would fail both assertions.
    const withCustomLib = renderWebUiBootRegion({ bust: [], entry: "./ui.mjs", libPath: "./assets/", packageName: "acme-plugin-name" });

    assert.match(withCustomLib, /fetch\("\.\/assets\/manifest\.json", \{ cache: "no-store" \}\)/, "the manifest fetch resolves against the supplied libPath");
    assert.match(withCustomLib, /new URL\("\.\/assets\/" \+ manifest\.subdir/, "the prefix URL resolves against the supplied libPath");
  });

  test("dynamically imports the entry module and fetches the manifest with cache: no-store", () => {

    assert.match(region, /await import\("\.\/ui\.mjs"\);/, "the block ends by importing the entry module");
    assert.match(region, /cache: "no-store"/, "the manifest fetch bypasses the HTTP cache");
  });

  test("renders the region in boot order: the status panel, then the classic monitor, then the module loader", () => {

    const panelIndex = region.indexOf("<div id=\"pageBootError\"");
    const monitorIndex = region.indexOf("<script>");
    const loaderIndex = region.indexOf("<script type=\"module\">");

    assert.ok(panelIndex >= 0, "the status panel is present");
    assert.ok((panelIndex < monitorIndex) && (monitorIndex < loaderIndex), "the panel precedes the monitor, which precedes the loader");
    assert.match(region, /<script>\n/, "the boot monitor is a classic script that carries no type attribute");
  });

  test("carries the four exact, contractual boot messages verbatim", () => {

    // The copy lives as contiguous panel text so a support grep and a screenshot both find it whole; a split-and-concatenated form would fail these contiguous checks.
    assert.ok(region.includes("Your browser doesn't support features this interface requires. Please use a current version of Safari or Chrome."),
      "the browser-bucket message appears verbatim");
    assert.ok(region.includes("The interface files couldn't be retrieved from the Homebridge server. Reload the page to try again. If this keeps happening, log out " +
      "of the Homebridge interface and log back in."), "the delivery-bucket message appears verbatim");
    assert.ok(region.includes("An unexpected error occurred while starting the interface."), "the generic-bucket message appears verbatim");
    assert.ok(region.includes("This is taking longer than expected. If nothing appears shortly, reload the page."), "the watchdog notice appears verbatim");
  });

  test("opens the technical-details disclosure so a screenshot is a complete report", () => {

    assert.match(region, /<details open>/, "the details disclosure is open by default");
    assert.match(region, /<summary>Technical details<\/summary>/, "the disclosure summary labels the technical details");
  });

  test("renders deterministically - two calls with the same inputs are byte-identical", () => {

    const again = renderWebUiBootRegion({ bust: ["./protect-config.mjs"], entry: "./ui.mjs", libPath: "./lib/", packageName: "homebridge-plugin-utils" });

    assert.equal(again, region, "the render is a pure function of its inputs, so the stamp is byte-stable across runs");
  });
});

describe("renderWebUiBootRegion - loader stage instrumentation (text-level)", () => {

  // The loader is a module script (top-level await, import.meta) that the test runner cannot execute without --experimental-vm-modules, so its stage progression and
  // catch classification are pinned by text-level assertions against the rendered block. Behavioral verification of these branches lives in the live dogfood probes.

  test("the stage flips to \"import\" only immediately before the entry import", () => {

    assert.match(region, /let stage = "manifest";/, "the stage starts at manifest");
    assert.match(region, /stage = "import";\n\n\s+await import\("\.\/ui\.mjs"\);/, "the stage flips to import immediately before the entry import");
  });

  test("guards the manifest response with an ok check that throws an end-user HTTP message before parsing", () => {

    assert.match(region, /if\(!response\.ok\)/, "the manifest response is checked before .json()");
    assert.match(region, /throw new Error\("The manifest request failed with HTTP status " \+ response\.status \+ "\."\);/,
      "a non-ok manifest response throws a plain-language HTTP-status message");
  });

  test("the manifest branch reports to the monitor without a capability probe", () => {

    assert.match(region, /} else {\n\n\s+window\.webUiBoot\.fail\("manifest", error\);/, "a manifest-stage failure reports the manifest bucket directly");
    assert.ok(region.lastIndexOf("import.meta.resolve") < region.indexOf("window.webUiBoot.fail(\"manifest\""),
      "no import.meta.resolve probe runs in the manifest branch");
  });

  test("the import branch probes import.meta.resolve to separate the browser bucket from delivery", () => {

    assert.match(region, /typeof import\.meta\.resolve !== "function"/, "an engine without import.meta.resolve predates the loader floor, so the browser bucket");
    assert.match(region, /import\.meta\.resolve\("homebridge-plugin-utils\/webUi\.mjs"\);/, "the probe resolves the injected package prefix");
    assert.match(region, /window\.webUiBoot\.fail\("import", error\);/, "a resolving probe leaves the failure in the delivery bucket");
  });
});

describe("boot monitor behavior", () => {

  test("an uncaught window error reveals the panel with the generic message and drops the host spinner", (t) => {

    using _dom = createTestDom();
    const { calls, fake } = spinnerSpyHomebridge();

    using _hb = installHomebridge(fake);

    startMonitor(t);

    const event = Object.assign(new Event("error"), { error: new Error("Kaboom.") });

    window.dispatchEvent(event);

    assert.equal(displayOf("pageBootError"), "block", "the panel is revealed on an uncaught error");
    assert.equal(bucketDisplay("generic"), "block", "an uncaught error selects the generic bucket");
    assert.equal(bucketDisplay("browser"), "none", "the other buckets stay hidden");
    assert.equal(calls.hideSpinner, 1, "the host spinner is dropped so it cannot mask the panel");
  });

  test("fail(\"browser\", ...) selects the browser bucket", (t) => {

    using _dom = createTestDom();
    const { fake } = spinnerSpyHomebridge();

    using _hb = installHomebridge(fake);

    startMonitor(t);
    bootMonitor().fail("browser", new Error("no import.meta.resolve"));

    assert.equal(bucketDisplay("browser"), "block", "the browser stage selects the browser bucket");
    assert.equal(bucketDisplay("delivery"), "none", "the delivery bucket stays hidden");
  });

  test("fail(\"manifest\", ...) and fail(\"import\", ...) both select the delivery bucket", (t) => {

    using _dom = createTestDom();
    const { fake } = spinnerSpyHomebridge();

    using _hb = installHomebridge(fake);

    startMonitor(t);
    bootMonitor().fail("manifest", new Error("fetch failed"));

    assert.equal(bucketDisplay("delivery"), "block", "the manifest stage selects the delivery bucket");
  });

  test("the import stage also selects the delivery bucket", (t) => {

    using _dom = createTestDom();
    const { fake } = spinnerSpyHomebridge();

    using _hb = installHomebridge(fake);

    startMonitor(t);
    bootMonitor().fail("import", new Error("module 404"));

    assert.equal(bucketDisplay("delivery"), "block", "the import stage selects the delivery bucket");
  });

  test("the first failure wins: a second fail() with a different stage is ignored", (t) => {

    using _dom = createTestDom();
    const { fake } = spinnerSpyHomebridge();

    using _hb = installHomebridge(fake);

    startMonitor(t);
    bootMonitor().fail("browser", new Error("first"));
    bootMonitor().fail("manifest", new Error("second"));

    assert.equal(bucketDisplay("browser"), "block", "the first failure's bucket stays shown");
    assert.equal(bucketDisplay("delivery"), "none", "the later failure's bucket is never revealed");
  });

  test("an unhandled rejection with an undefined reason reveals the generic message with a defensively-derived error line", (t) => {

    using _dom = createTestDom();
    const { fake } = spinnerSpyHomebridge();

    using _hb = installHomebridge(fake);

    startMonitor(t);

    const event = Object.assign(new Event("unhandledrejection"), { reason: undefined });

    window.dispatchEvent(event);

    const details = document.getElementById("bootErrorDetails");
    const text = details?.textContent ?? "";

    assert.equal(bucketDisplay("generic"), "block", "an unhandled rejection falls to the generic bucket");
    assert.ok(text.includes("Stage: unhandled rejection"), "the stage label reads in plain words");
    assert.ok(text.includes("Error: undefined"), "an undefined reason coerces to the string undefined rather than throwing");
  });

  test("neither handler calls preventDefault, so the browser console keeps every error", (t) => {

    using _dom = createTestDom();
    const { fake } = spinnerSpyHomebridge();

    using _hb = installHomebridge(fake);

    startMonitor(t);

    let prevented = false;
    const event = Object.assign(new Event("error", { cancelable: true }), { error: new Error("boom") });

    event.preventDefault = (): void => {

      prevented = true;
    };

    window.dispatchEvent(event);

    assert.equal(prevented, false, "the error handler must not suppress the browser's own console reporting");
  });

  test("the watchdog reveals the slow notice and drops the spinner, and a later ready() retracts it", (t) => {

    using _dom = createTestDom();
    const { calls, fake } = spinnerSpyHomebridge();

    using _hb = installHomebridge(fake);

    startMonitor(t);

    assert.equal(displayOf("bootSlowNotice"), "none", "the slow notice is hidden before the watchdog fires");

    t.mock.timers.tick(10000);

    assert.equal(displayOf("bootSlowNotice"), "block", "the watchdog reveals the slow notice at the deadline");
    assert.equal(calls.hideSpinner, 1, "the watchdog drops the spinner so the notice replaces it");

    bootMonitor().ready();

    assert.equal(displayOf("bootSlowNotice"), "none", "a boot that finishes later retracts the notice through ready()");
  });

  test("a visible watchdog notice is replaced by the error panel when a failure lands afterward", (t) => {

    using _dom = createTestDom();
    const { fake } = spinnerSpyHomebridge();

    using _hb = installHomebridge(fake);

    startMonitor(t);
    t.mock.timers.tick(10000);

    assert.equal(displayOf("bootSlowNotice"), "block", "the watchdog notice is showing");

    bootMonitor().fail("manifest", new Error("late failure"));

    assert.equal(displayOf("bootSlowNotice"), "none", "the notice is retracted when the error panel supersedes it");
    assert.equal(displayOf("pageBootError"), "block", "the error panel is revealed");
    assert.equal(bucketDisplay("delivery"), "block", "the panel shows the failing stage's bucket");
  });

  test("ready() tears the monitor down: the watchdog is cleared, listeners are removed, and both surfaces stay hidden", (t) => {

    using _dom = createTestDom();
    const { fake } = spinnerSpyHomebridge();

    using _hb = installHomebridge(fake);

    startMonitor(t);
    bootMonitor().ready();

    // The watchdog was cleared, so ticking past the deadline reveals nothing.
    t.mock.timers.tick(10000);

    assert.equal(displayOf("bootSlowNotice"), "none", "ready() cleared the watchdog, so the slow notice never appears");

    // The listeners were removed, so a subsequent uncaught error is ignored.
    const event = Object.assign(new Event("error"), { error: new Error("after ready") });

    window.dispatchEvent(event);

    assert.equal(displayOf("pageBootError"), "none", "ready() removed the listeners, so a later error reveals nothing");
  });

  test("ready() after a failure retracts the shown panel", (t) => {

    using _dom = createTestDom();
    const { fake } = spinnerSpyHomebridge();

    using _hb = installHomebridge(fake);

    startMonitor(t);
    bootMonitor().fail("browser", new Error("boom"));

    assert.equal(displayOf("pageBootError"), "block", "the panel is shown after the failure");

    bootMonitor().ready();

    assert.equal(displayOf("pageBootError"), "none", "ready() supersedes the shown panel because the app is alive");
  });

  test("fail() after ready() is a no-op", (t) => {

    using _dom = createTestDom();
    const { fake } = spinnerSpyHomebridge();

    using _hb = installHomebridge(fake);

    startMonitor(t);
    bootMonitor().ready();
    bootMonitor().fail("browser", new Error("too late"));

    assert.equal(displayOf("pageBootError"), "none", "a failure after ready() never reveals the panel");
  });

  test("a second execution in the same window is a no-op: one registration, one watchdog", (t) => {

    using _dom = createTestDom();
    const { calls, fake } = spinnerSpyHomebridge();

    using _hb = installHomebridge(fake);

    startMonitor(t);

    const first = rawBootMonitor();

    // Re-running the classic script in the same window sees the existing registration and returns immediately, so the frozen object's identity is unchanged.
    runInThisContext(monitorSource);

    assert.equal(rawBootMonitor(), first, "the second execution does not re-register window.webUiBoot");

    t.mock.timers.tick(10000);

    assert.equal(calls.hideSpinner, 1, "only the first run's single watchdog fired, so the spinner is dropped once");
  });

  test("the details lines carry the stage, the error text, and the user agent, assigned as plain text", (t) => {

    using _dom = createTestDom();
    const { fake } = spinnerSpyHomebridge();

    using _hb = installHomebridge(fake);

    startMonitor(t);
    bootMonitor().fail("manifest", new Error("<img src=x>"));

    const details = document.getElementById("bootErrorDetails");
    const text = details?.textContent ?? "";

    assert.ok(text.includes("Stage: manifest"), "the stage line names the failing stage");
    assert.ok(text.includes("Error: <img src=x>"), "the error line carries the raw message");
    assert.match(text, /Browser: \S/, "the browser line carries the user agent");
    assert.equal(details?.querySelector("img"), null, "the untrusted error text is assigned via textContent, never parsed as markup");
  });
});
