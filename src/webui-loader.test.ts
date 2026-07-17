/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webui-loader.test.ts: Unit tests for the webUI script-loader stamp - config parsing and block rendering.
 */
import { WEBUI_LOADER_BEGIN, WEBUI_LOADER_END, parseWebUiLoaderConfig, renderWebUiLoaderScript } from "./webui-loader.ts";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

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

describe("renderWebUiLoaderScript", () => {

  // The rendered block for a representative config. Shared across the content-form assertions below so each pins one property of the same output.
  const rendered = renderWebUiLoaderScript({ bust: ["./protect-config.mjs"], entry: "./ui.mjs", libPath: "./lib/", packageName: "homebridge-plugin-utils" });

  test("busts the ENTRY module itself: its importmap key is the bare path and its value is the bust() call, not an identity mapping", () => {

    // The entry sits outside the package's hashed versioning, so an unbusted entry (an identity mapping) would regress the cache-bust of the most important module. The
    // bare-key-with-bust()-value form is what a bare name-presence check would miss.
    assert.match(rendered, /"\.\/ui\.mjs": bust\("\.\/ui\.mjs"\)/, "the entry module maps its bare key to a bust() call");
    assert.doesNotMatch(rendered, /"\.\/ui\.mjs": "\.\/ui\.mjs"/, "the entry must not be an unbusted identity mapping");
  });

  test("busts each declared bust entry: bare key, bust() value", () => {

    assert.match(rendered, /"\.\/protect-config\.mjs": bust\("\.\/protect-config\.mjs"\)/, "the bust entry maps its bare key to a bust() call");
  });

  test("the bust() helper appends the shared ?cb= cache-bust parameter", () => {

    assert.match(rendered, /const bust = \(path\) => new URL\(path, import\.meta\.url\)\.href \+ "\?cb=" \+ cb;/, "bust() resolves against import.meta.url + ?cb=");
    assert.match(rendered, /const cb = Date\.now\(\);/, "a single Date.now() stamp is shared across the page load");
  });

  test("the trailing-slash prefix entry maps a SYNTHETIC packageName - not a hardcoded literal - to the hashed subdir", () => {

    // A synthetic package name distinct from the real one: a hardcoded-literal implementation that emitted "homebridge-plugin-utils/" would fail this.
    const withSyntheticName = renderWebUiLoaderScript({ bust: [], entry: "./ui.mjs", libPath: "./lib/", packageName: "acme-plugin-name" });

    assert.match(withSyntheticName, /"acme-plugin-name\/": new URL\("\.\/lib\/" \+ manifest\.subdir \+ "\/", import\.meta\.url\)\.href/,
      "the prefix key is the supplied package name, mapped to the hashed subdir");
    assert.doesNotMatch(withSyntheticName, /"homebridge-plugin-utils\/":/, "no hardcoded package-name prefix key may leak into the importmap");
  });

  test("libPath drives both the manifest fetch and the prefix URL - not a hardcoded ./lib/", () => {

    // A distinct libPath: a hardcoded "./lib/" that ignored the argument would fail both assertions.
    const withCustomLib = renderWebUiLoaderScript({ bust: [], entry: "./ui.mjs", libPath: "./assets/", packageName: "acme-plugin-name" });

    assert.match(withCustomLib, /fetch\("\.\/assets\/manifest\.json", \{ cache: "no-store" \}\)/, "the manifest fetch resolves against the supplied libPath");
    assert.match(withCustomLib, /new URL\("\.\/assets\/" \+ manifest\.subdir/, "the prefix URL resolves against the supplied libPath");
  });

  test("dynamically imports the entry module and fetches the manifest with cache: no-store", () => {

    assert.match(rendered, /await import\("\.\/ui\.mjs"\);/, "the block ends by importing the entry module");
    assert.match(rendered, /cache: "no-store"/, "the manifest fetch bypasses the HTTP cache");
  });

  test("renders deterministically - two calls with the same inputs are byte-identical", () => {

    const again = renderWebUiLoaderScript({ bust: ["./protect-config.mjs"], entry: "./ui.mjs", libPath: "./lib/", packageName: "homebridge-plugin-utils" });

    assert.equal(again, rendered, "the render is a pure function of its inputs, so the stamp is byte-stable across runs");
  });
});
