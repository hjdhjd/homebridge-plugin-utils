/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui/webUi-theming.test.mjs: Unit tests for the page theme effect - its lifecycle, the color-scheme application, the page base stylesheet, and the page kit.
 */
"use strict";

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createTestDom } from "./ui.helpers.mjs";
import { setImmediate as flushImmediate } from "node:timers/promises";
import { registerThemeEffect } from "./webUi-theming.mjs";

// Build a fake host whose userCurrentLightingMode returns the supplied mode. Tests override per-call.
const fakeHost = (mode) => ({ userCurrentLightingMode: async () => mode });

// A fake host whose mode a test can flip between reads, which is exactly what a host theme toggle looks like from this page: the announcement arrives on a route,
// and the mode the bridge reports afterwards is the new one. `reads` counts the bridge calls, so a row can prove a route reached the follower at all.
const flippableHost = (mode) => {

  const host = {

    mode,
    reads: 0,

    userCurrentLightingMode() {

      host.reads += 1;

      return Promise.resolve(host.mode);
    }
  };

  return host;
};

// Seed Bootstrap's `.d-none` readiness shim plus a `.btn-primary` the accent probe can read, so a probe that runs writes an observable value onto `:root`.
const seedBootstrapProbeShim = () => {

  const sheet = new CSSStyleSheet();

  sheet.replaceSync(".d-none { display: none; } .btn-primary { background-color: rgb(33, 37, 41); color: rgb(255, 255, 255); }");
  document.adoptedStyleSheets = [ ...document.adoptedStyleSheets, sheet ];
};

// The probed accent the shim above puts on `.btn-primary`, so a re-probe is observable as this exact value landing back on the token.
const PROBED_ACCENT = "rgb(33, 37, 41)";

// Drain queued async work. The follow path is a bridge read plus its continuation, so a handful of macrotask cycles covers it without waiting on wall-clock time.
const flush = async () => {

  for(let i = 0; i < 12; i++) {

    // Sequential awaits are intentional: each cycle must complete before the next is scheduled, since they drain a chained queue rather than parallel work.
    // eslint-disable-next-line no-await-in-loop
    await flushImmediate();
  }
};

// Dispatch the host's own theme announcement into this window, in the shape Homebridge posts it.
const postThemeUpdate = (data = { isDark: true, theme: "dark", type: "theme-update" }) => window.dispatchEvent(new window.MessageEvent("message", { data }));

// Adopt the base sheet and return its rules joined as text. The effect adopts synchronously before it awaits the lighting mode, so the sheet is present once this
// resolves; the probe is skipped with timeoutMs 0.
const baseCss = async () => {

  const controller = new AbortController();

  await registerThemeEffect({ host: fakeHost("light"), probe: { timeoutMs: 0 }, signal: controller.signal });

  const stylesheet = document.adoptedStyleSheets[document.adoptedStyleSheets.length - 1];

  return [...stylesheet.cssRules].map((rule) => rule.cssText).join("\n");
};

describe("registerThemeEffect - synchronous setup", () => {

  test("adopts a stylesheet onto document.adoptedStyleSheets", async () => {

    using _dom = createTestDom();

    const before = document.adoptedStyleSheets.length;
    const controller = new AbortController();

    await registerThemeEffect({ host: fakeHost("light"), probe: { timeoutMs: 0 }, signal: controller.signal });

    assert.equal(document.adoptedStyleSheets.length, before + 1, "stylesheet adopted");
  });

  test("applies color-scheme on :root from the host's reported lighting mode", async () => {

    using _dom = createTestDom();

    const controller = new AbortController();

    await registerThemeEffect({ host: fakeHost("dark"), probe: { timeoutMs: 0 }, signal: controller.signal });

    assert.equal(document.documentElement.style.getPropertyValue("color-scheme"), "dark");
    assert.equal(document.documentElement.classList.contains("fo-dark"), true);
  });

  test("light mode does not set the fo-dark class", async () => {

    using _dom = createTestDom();

    const controller = new AbortController();

    await registerThemeEffect({ host: fakeHost("light"), probe: { timeoutMs: 0 }, signal: controller.signal });

    assert.equal(document.documentElement.style.getPropertyValue("color-scheme"), "light");
    assert.equal(document.documentElement.classList.contains("fo-dark"), false);
  });

  test("an unrecognized lighting-mode value is a no-op (no class or property change)", async () => {

    using _dom = createTestDom();

    const controller = new AbortController();

    await registerThemeEffect({ host: fakeHost("auto"), probe: { timeoutMs: 0 }, signal: controller.signal });

    assert.equal(document.documentElement.style.getPropertyValue("color-scheme"), "", "no color-scheme set");
    assert.equal(document.documentElement.classList.contains("fo-dark"), false);
  });
});

describe("registerThemeEffect - lifecycle", () => {

  test("aborting the signal releases the stylesheet", async () => {

    using _dom = createTestDom();

    const before = document.adoptedStyleSheets.length;
    const controller = new AbortController();

    await registerThemeEffect({ host: fakeHost("light"), probe: { timeoutMs: 0 }, signal: controller.signal });
    assert.equal(document.adoptedStyleSheets.length, before + 1);

    controller.abort();
    assert.equal(document.adoptedStyleSheets.length, before, "stylesheet released");
  });

  test("aborting clears the color-scheme, fo-dark class, and accent overrides it set on :root", async () => {

    using _dom = createTestDom();

    const controller = new AbortController();

    // Register in dark mode so applyColorScheme sets both color-scheme and the fo-dark class; stamp accent overrides directly (the probe is skipped via
    // timeoutMs: 0) so the teardown has every kind of :root mutation to undo.
    await registerThemeEffect({ host: fakeHost("dark"), probe: { timeoutMs: 0 }, signal: controller.signal });
    document.documentElement.style.setProperty("--fo-accent-bg", "rgb(1, 2, 3)");
    document.documentElement.style.setProperty("--fo-accent-fg", "rgb(4, 5, 6)");

    assert.equal(document.documentElement.style.getPropertyValue("color-scheme"), "dark", "precondition: dark applied");
    assert.equal(document.documentElement.classList.contains("fo-dark"), true, "precondition: fo-dark set");

    controller.abort();

    assert.equal(document.documentElement.style.getPropertyValue("color-scheme"), "", "color-scheme cleared on teardown");
    assert.equal(document.documentElement.classList.contains("fo-dark"), false, "fo-dark class removed on teardown");
    assert.equal(document.documentElement.style.getPropertyValue("--fo-accent-bg"), "", "accent-bg override cleared on teardown");
    assert.equal(document.documentElement.style.getPropertyValue("--fo-accent-fg"), "", "accent-fg override cleared on teardown");
  });

  test("a pre-aborted signal does not adopt anything", async () => {

    using _dom = createTestDom();

    const before = document.adoptedStyleSheets.length;
    const controller = new AbortController();

    controller.abort();
    await registerThemeEffect({ host: fakeHost("light"), probe: { timeoutMs: 0 }, signal: controller.signal });

    assert.equal(document.adoptedStyleSheets.length, before);
    assert.equal(document.documentElement.style.getPropertyValue("color-scheme"), "");
  });
});

describe("registerThemeEffect - following the host's theme signals", () => {

  test("the host's theme-update message re-keys the dark class and re-probes the accent", async () => {

    using _dom = createTestDom();

    seedBootstrapProbeShim();

    const host = flippableHost("light");
    const controller = new AbortController();

    await registerThemeEffect({ host, probe: { timeoutMs: 0 }, signal: controller.signal });
    await flush();

    assert.equal(document.documentElement.classList.contains("fo-dark"), false, "precondition: the page registered in light mode");

    // Clearing the token is what makes the re-probe observable: the initial registration already probed, so a value still sitting there afterwards would prove
    // nothing about whether the route ran one.
    document.documentElement.style.removeProperty("--fo-accent-bg");
    host.mode = "dark";
    postThemeUpdate();
    await flush();

    assert.equal(document.documentElement.classList.contains("fo-dark"), true, "the announcement re-keyed the dark class");
    assert.equal(document.documentElement.style.getPropertyValue("color-scheme"), "dark", "and re-applied the color-scheme");
    assert.equal(document.documentElement.style.getPropertyValue("--fo-accent-bg"), PROBED_ACCENT, "and re-probed the accent off the host's current chrome");
  });

  test("a mutation of the frame body's theme classes does the same", async () => {

    using _dom = createTestDom();

    seedBootstrapProbeShim();

    const host = flippableHost("light");
    const controller = new AbortController();

    await registerThemeEffect({ host, probe: { timeoutMs: 0 }, signal: controller.signal });
    await flush();

    document.documentElement.style.removeProperty("--fo-accent-bg");
    host.mode = "dark";

    // The host retints a plugin frame by swapping theme classes on its body, so this IS the retint rather than an announcement of one.
    document.body.classList.add("dark-mode");
    await flush();

    assert.equal(document.documentElement.classList.contains("fo-dark"), true, "the body-class retint re-keyed the dark class");
    assert.equal(document.documentElement.style.getPropertyValue("color-scheme"), "dark", "and re-applied the color-scheme");
    assert.equal(document.documentElement.style.getPropertyValue("--fo-accent-bg"), PROBED_ACCENT, "and re-probed the accent");
  });

  test("the message route carries the page back out of dark mode as readily as into it", async () => {

    using _dom = createTestDom();

    seedBootstrapProbeShim();

    const host = flippableHost("dark");
    const controller = new AbortController();

    await registerThemeEffect({ host, probe: { timeoutMs: 0 }, signal: controller.signal });
    await flush();

    assert.equal(document.documentElement.classList.contains("fo-dark"), true, "precondition: the page registered in dark mode");

    // Clearing the token is what makes the re-probe observable: the initial registration already probed, so a value still sitting there afterwards would prove
    // nothing about whether the route ran one.
    document.documentElement.style.removeProperty("--fo-accent-bg");
    host.mode = "light";
    postThemeUpdate({ isDark: false, theme: "light", type: "theme-update" });
    await flush();

    // The removal is the half a route that only ever adds would still pass without: a user who switches Homebridge back to light has to get a light page.
    assert.equal(document.documentElement.classList.contains("fo-dark"), false, "the announcement took the dark class off :root");
    assert.equal(document.documentElement.style.getPropertyValue("color-scheme"), "light", "and re-applied the color-scheme in this direction too");
    assert.equal(document.documentElement.style.getPropertyValue("--fo-accent-bg"), PROBED_ACCENT, "and re-probed the accent off the host's current chrome");
  });

  test("the body-class route carries the page back out of dark mode as readily as into it", async () => {

    using _dom = createTestDom();

    seedBootstrapProbeShim();

    const host = flippableHost("dark");
    const controller = new AbortController();

    // The page loads into a frame the host has already retinted dark, so the class is on the body before anything is watching it.
    document.body.classList.add("dark-mode");

    await registerThemeEffect({ host, probe: { timeoutMs: 0 }, signal: controller.signal });
    await flush();

    assert.equal(document.documentElement.classList.contains("fo-dark"), true, "precondition: the page registered in dark mode");

    document.documentElement.style.removeProperty("--fo-accent-bg");
    host.mode = "light";

    // Dropping the theme class it had added is as much a retint as adding one, so the observer has to answer it the same way.
    document.body.classList.remove("dark-mode");
    await flush();

    assert.equal(document.documentElement.classList.contains("fo-dark"), false, "the body-class retint took the dark class off :root");
    assert.equal(document.documentElement.style.getPropertyValue("color-scheme"), "light", "and re-applied the color-scheme in this direction too");
    assert.equal(document.documentElement.style.getPropertyValue("--fo-accent-bg"), PROBED_ACCENT, "and re-probed the accent");
  });

  test("both routes re-read the mode through the bridge rather than trusting the announcement", async () => {

    using _dom = createTestDom();

    seedBootstrapProbeShim();

    const host = flippableHost("light");
    const controller = new AbortController();

    await registerThemeEffect({ host, probe: { timeoutMs: 0 }, signal: controller.signal });
    await flush();

    const afterRegistration = host.reads;

    // A message claiming dark while the bridge still reports light must leave the page in light: the payload is read for its type alone, and the bridge is the one
    // authority on which mode is current.
    postThemeUpdate({ isDark: true, theme: "dark", type: "theme-update" });
    await flush();

    assert.equal(host.reads, afterRegistration + 1, "the route re-read the mode");
    assert.equal(document.documentElement.classList.contains("fo-dark"), false, "and the bridge's answer decided the outcome, not the message's own claim");
  });

  test("a message that is not a theme announcement is ignored", async () => {

    using _dom = createTestDom();

    seedBootstrapProbeShim();

    const host = flippableHost("light");
    const controller = new AbortController();

    await registerThemeEffect({ host, probe: { timeoutMs: 0 }, signal: controller.signal });
    await flush();

    const afterRegistration = host.reads;

    document.documentElement.style.removeProperty("--fo-accent-bg");
    host.mode = "dark";
    postThemeUpdate({ payload: "irrelevant", type: "some-other-plugin-message" });

    // A payload-less message too: the optional chain on `data` is what keeps a bare notification from throwing inside the listener.
    postThemeUpdate(null);
    await flush();

    assert.equal(host.reads, afterRegistration, "neither foreign message reached the bridge");
    assert.equal(document.documentElement.classList.contains("fo-dark"), false, "and neither retinted the page");
    assert.equal(document.documentElement.style.getPropertyValue("--fo-accent-bg"), "", "and neither drove an accent probe");
  });

  test("the system color-scheme query is not one of the routes", async () => {

    using _dom = createTestDom();

    seedBootstrapProbeShim();

    // The query answers before the host has retinted anything, and on an install pinned to one mode it fires when nothing about the page changed - so the effect
    // must not even ask for it. Spying the constructor rather than the listener is what makes that provable: a query that is never built cannot be subscribed to.
    const queries = [];
    const realMatchMedia = window.matchMedia;

    window.matchMedia = (query) => {

      queries.push(query);

      return realMatchMedia.call(window, query);
    };

    const controller = new AbortController();

    try {

      await registerThemeEffect({ host: flippableHost("dark"), probe: { timeoutMs: 0 }, signal: controller.signal });
      await flush();
    } finally {

      window.matchMedia = realMatchMedia;
    }

    assert.deepEqual(queries, [], "the effect never constructs a media query");
    assert.equal(document.documentElement.classList.contains("fo-dark"), true, "precondition: the effect did run and did theme the page");
  });

  test("teardown disconnects the class observer, so a later body-class change reaches nothing", async () => {

    using _dom = createTestDom();

    seedBootstrapProbeShim();

    const host = flippableHost("light");
    const controller = new AbortController();

    await registerThemeEffect({ host, probe: { timeoutMs: 0 }, signal: controller.signal });
    await flush();

    // The control that makes the silence after teardown attributable: without proving the observer delivered first, its later quiet could mean it was never
    // constructed at all.
    document.body.classList.add("dark-mode");
    await flush();

    const whileLive = host.reads;

    assert.ok(whileLive > 0, "precondition: the observer is live and a body-class change reaches the follower");

    controller.abort();
    document.body.classList.remove("dark-mode");
    await flush();

    assert.equal(host.reads, whileLive, "a body-class change after teardown reaches nothing");
  });

  test("an abort during the initial mode read tears down cleanly and leaves no observer behind", async () => {

    using _dom = createTestDom();

    seedBootstrapProbeShim();

    const before = document.adoptedStyleSheets.length;
    const initialRead = Promise.withResolvers();
    const host = flippableHost("dark");

    // The first read never answers until this test says so, which is what holds the effect open at its one await. Every later read answers at once, so the routes
    // below are free to run while the registration is still parked.
    host.userCurrentLightingMode = () => {

      host.reads += 1;

      return (host.reads === 1) ? initialRead.promise : Promise.resolve(host.mode);
    };

    const controller = new AbortController();
    const registration = registerThemeEffect({ host, probe: { timeoutMs: 0 }, signal: controller.signal });

    await flush();

    assert.equal(host.reads, 1, "precondition: the initial read is in flight");
    assert.equal(document.adoptedStyleSheets.length, before + 1, "precondition: the sheet is adopted before that read settles");

    // The observer-liveness precondition. Without it the disconnect assertion at the end passes identically when the observer was never constructed, which is
    // exactly the misordering this row exists to catch.
    document.body.classList.add("dark-mode");
    await flush();

    assert.equal(host.reads, 2, "precondition: the class observer is already live while the initial read is still parked");

    controller.abort();
    initialRead.resolve("dark");

    // Awaiting the registration is the no-throw assertion: a teardown that raced the read resuming would surface here.
    await registration;
    await flush();

    assert.equal(document.adoptedStyleSheets.length, before, "the sheet is released");
    assert.equal(document.documentElement.classList.contains("fo-dark"), false, "the dark class is gone");
    assert.equal(document.documentElement.style.getPropertyValue("color-scheme"), "", "the color-scheme is gone");

    const afterTeardown = host.reads;

    document.body.classList.remove("dark-mode");
    await flush();

    assert.equal(host.reads, afterTeardown, "and the observer was disconnected - a post-teardown class change reaches nothing");
  });

  test("a follow already in flight when the teardown lands cannot put the theme back afterwards", async () => {

    using _dom = createTestDom();

    seedBootstrapProbeShim();

    const host = flippableHost("light");
    const controller = new AbortController();

    await registerThemeEffect({ host, probe: { timeoutMs: 0 }, signal: controller.signal });
    await flush();

    // Park the follow's own read, then announce a change: the follower is now suspended between reading the mode and writing it.
    const followRead = Promise.withResolvers();

    host.userCurrentLightingMode = () => followRead.promise;
    postThemeUpdate();
    await flush();

    controller.abort();
    followRead.resolve("dark");
    await flush();

    // A write that raced the teardown would put the theme back on a document the effect had already promised to leave untouched.
    assert.equal(document.documentElement.style.getPropertyValue("color-scheme"), "", "no color-scheme survived the teardown");
    assert.equal(document.documentElement.classList.contains("fo-dark"), false, "no dark class survived it");
    assert.equal(document.documentElement.style.getPropertyValue("--fo-accent-bg"), "", "no accent background survived it");
    assert.equal(document.documentElement.style.getPropertyValue("--fo-accent-fg"), "", "no accent foreground survived it");
  });
});

describe("buildBaseCss - page rules", () => {

  test("the secret field seats its toggle beside the input, and the toggle wears no button chrome of its own", async () => {

    using _dom = createTestDom();

    const text = await baseCss();

    // The wrapper is a horizontal flex line inside the stacking content cell, which is what puts the reveal beside the field rather than beneath it.
    assert.match(text, /\.fo-secret-field\s*\{[^}]*display:\s*flex/);
    assert.match(text, /\.fo-secret-field\s*\{[^}]*align-items:\s*center/);

    // The toggle surrenders the native button background and border and inherits the row's text color, which is what the currentColor glyph inside it draws in.
    assert.match(text, /\.fo-secret-toggle\s*\{[^}]*background:\s*none/);
    assert.match(text, /\.fo-secret-toggle\s*\{[^}]*color:\s*inherit/);
    assert.match(text, /\.fo-secret-toggle\s*\{[^}]*cursor:\s*pointer/);

    // Surrendering the chrome surrenders the browser's disabled rendering too, so a locked row's toggle dims and drops the pointer rather than inviting a click it
    // will not answer. The dim reads the shared not-actionable token rather than carrying a value of its own.
    assert.match(text, /\.fo-secret-toggle:disabled\s*\{[^}]*cursor:\s*default/);
    assert.match(text, /\.fo-secret-toggle:disabled\s*\{[^}]*opacity:\s*var\(--fo-opacity-disabled\)/);
  });

  test("the dark corrections for Bootstrap's page-wide text utilities read the muted token and outrank Bootstrap's own weight", async () => {

    using _dom = createTestDom();

    const text = await baseCss();

    // Bootstrap pins its own grey on these utilities with `!important`, so the correction has to carry the same weight to reach them at all - and it reads the
    // muted token rather than a literal so the page has one definition of muted text in either mode.
    assert.match(text, /:root\.fo-dark \.text-body\s*\{[^}]*color:\s*var\(--fo-text-muted\)\s*!important/);
    assert.match(text, /:root\.fo-dark \.text-muted\s*\{[^}]*color:\s*var\(--fo-text-muted\)\s*!important/);
  });

  test("the menu tabs put the accent fill on the active one and a mode-aware ghost on the rest", async () => {

    using _dom = createTestDom();

    const text = await baseCss();

    /* The pair is asserted together because the reading depends on the contrast between them: an accent fill against a transparent ghost is what keeps the
     * eye-catching treatment on the tab the user is on, in either mode. Happy-DOM expands a `border` shorthand carrying a `var()` into longhands, so the ghost's
     * border color is read off `border-color` while the active rule's literal-valued shorthand survives intact.
     */
    assert.match(text, /\.fo-menu\s*\{[^}]*background:\s*transparent/, "the ghost declares no fill of its own");
    assert.match(text, /\.fo-menu\s*\{[^}]*border-color:\s*var\(--fo-border-subtle\)/, "and takes its hairline from the mode-aware subtle border token");
    assert.match(text, /\.fo-menu\s*\{[^}]*color:\s*var\(--fo-text-muted\)/, "with the mode-aware muted text token, which is what reads quietly on either canvas");
    assert.match(text, /\.fo-menu-active[^{]*\{[^}]*background:\s*var\(--fo-accent-bg\)/, "the active tab takes the host-probed accent as its fill");
    assert.match(text, /\.fo-menu-active[^{]*\{[^}]*color:\s*var\(--fo-accent-fg\)/, "with the accent's own foreground, so the pair travels together");

    // The hover tint is scoped away from the active tab, which is what keeps a hover from lifting the accent fill off the tab the user is already on.
    assert.match(text, /\.fo-menu:not\(\.fo-menu-active\):hover\s*\{[^}]*background:\s*var\(--fo-accent-hover\)/, "hover tints only a tab the user can move to");
  });

  test("the menu tabs pin their colors through hover, focus, and press, leaving the focus ring to the host", async () => {

    using _dom = createTestDom();

    const text = await baseCss();

    /* The host carries its own stateful `.btn` rules, and a class-plus-pseudo-class selector outranks a bare class - so a state our rules do not describe is one the
     * page around us describes instead, and a tab wearing no Bootstrap variant resolves those rules to the canvas showing through. Each state is therefore named
     * explicitly, and the active selector list keeps its resting selector alongside its state ones so the two cannot drift apart.
     */
    assert.match(text, /\.fo-menu-active,\s*\.fo-menu-active:hover,\s*\.fo-menu-active:focus,\s*\.fo-menu-active:active\s*\{/,
      "the accent fill is declared for the resting active tab and for each of its interactive states in one rule");
    assert.match(text, /\.fo-menu:hover,\s*\.fo-menu:focus,\s*\.fo-menu:active\s*\{[^}]*border-color:\s*var\(--fo-border-subtle\)/,
      "the ghost holds its hairline through its own states");
    assert.match(text, /\.fo-menu:hover,\s*\.fo-menu:focus,\s*\.fo-menu:active\s*\{[^}]*color:\s*var\(--fo-text-muted\)/,
      "and its muted text with it");

    // Background is deliberately absent from the ghost's state rule: the tint rule owns the non-active hover fill and the resting ghost is already transparent.
    assert.doesNotMatch(text, /\.fo-menu:hover,\s*\.fo-menu:focus,\s*\.fo-menu:active\s*\{[^}]*background:/,
      "the ghost's state rule leaves the background to the tint rule that owns it");

    // Focus indication belongs to the host. Pinning a box-shadow or an outline here would take the focus ring with it, so neither appears in any menu rule.
    for(const rule of text.split("\n").filter((line) => line.includes(".fo-menu"))) {

      assert.doesNotMatch(rule, /box-shadow|outline/, "no menu rule touches the properties the host's focus ring is drawn with");
    }
  });

  test("the forced canvas owns the background and the inherited text color together", async () => {

    using _dom = createTestDom();

    const text = await baseCss();

    // Forcing the surface without forcing the text is what lets the host's modal color land on our background, so the pair is asserted together rather than one
    // at a time - either half alone is the failure this rule exists to prevent.
    assert.match(text, /body\s*\{[^}]*background-color:\s*var\(--fo-surface-bg\)\s*!important/);
    assert.match(text, /body\s*\{[^}]*color:\s*var\(--fo-text-on-elevated\)\s*!important/);
  });
});

describe("buildBaseCss - the page kit", () => {

  test("the card frame declares the accent border and the shared radius", async () => {

    using _dom = createTestDom();

    const text = await baseCss();

    /* The card is the framework's own container frame offered to a plugin's custom views, so its two declared values are the ones every framework container
     * already wears. Happy-DOM expands the `border` shorthand into longhands when its value carries a `var()`, so the color half is read off `border-color` here
     * rather than out of the shorthand; the source string's byte fidelity is the rule-parity rig's business, and this row's is the declared values.
     */
    assert.match(text, /\.fo-card\s*\{[^}]*1px solid/, "the frame is a hairline border");
    assert.match(text, /\.fo-card\s*\{[^}]*border-color:\s*var\(--fo-border-accent\)/, "and it takes its color from the shared container-frame token");
    assert.match(text, /\.fo-card\s*\{[^}]*border-radius:\s*var\(--fo-radius-md\)/, "with the shared radius, so a plugin card and a framework container match");
  });

  test("the monospace opt-in reads the shared font stack rather than restating one", async () => {

    using _dom = createTestDom();

    assert.match(await baseCss(), /\.fo-monospace\s*\{[^}]*font-family:\s*var\(--fo-font-monospace\)/);
  });

  test("the dark form-control corrections apply only inside a page-kit container, and every value reads its token", async () => {

    using _dom = createTestDom();

    const text = await baseCss();

    /* The surface, the border, and the text move together - a field that corrected only its background would render dark-on-dark - and the placeholder and the
     * focus state come with them so a field cannot flash a light background the moment it takes focus. Each declared value is pinned to its exact token: a
     * literal here would be a second definition of a color the tokens module already owns.
     */
    assert.match(text, /:root\.fo-dark \.fo-page \.form-control\s*\{[^}]*background-color:\s*var\(--fo-form-control-bg\)/);
    assert.match(text, /:root\.fo-dark \.fo-page \.form-control\s*\{[^}]*border-color:\s*var\(--fo-form-control-border\)/);
    assert.match(text, /:root\.fo-dark \.fo-page \.form-control\s*\{[^}]*color:\s*var\(--fo-text-on-elevated\)/);
    assert.match(text, /:root\.fo-dark \.fo-page \.form-control::placeholder\s*\{[^}]*color:\s*var\(--fo-form-control-placeholder\)/);
    assert.match(text, /:root\.fo-dark \.fo-page \.form-control:focus\s*\{[^}]*background-color:\s*var\(--fo-form-control-bg\)/);
    assert.match(text, /:root\.fo-dark \.fo-page \.form-control:focus\s*\{[^}]*border-color:\s*var\(--fo-form-control-focus-border\)/);
    assert.match(text, /:root\.fo-dark \.fo-page \.form-control:focus\s*\{[^}]*box-shadow:\s*var\(--fo-focus-ring\)/);
    assert.match(text, /:root\.fo-dark \.fo-page \.form-control:focus\s*\{[^}]*color:\s*var\(--fo-text-on-elevated\)/);

    // The `.fo-page` marker is what makes the kit opt-in: every form-control correction is scoped through it, so a page that never carries the marker sees none
    // of them and an option row's own inputs - which carry no such ancestor - are untouched.
    const unscoped = text.match(/:root\.fo-dark (?!\.fo-page)[^{]*\.form-control/g);

    assert.equal(unscoped, null, "no dark form-control correction in the base sheet escapes the page-kit marker");
  });

  test("light mode is left to Bootstrap - the kit declares no light form-control rules of its own", async () => {

    using _dom = createTestDom();

    // The framework treats its own fields this way, and a light-mode override here would be the framework second-guessing Bootstrap on a surface Bootstrap already
    // renders correctly. Only the dark-qualified selectors may mention `.fo-page` form controls.
    const text = await baseCss();
    const pageFormRules = text.match(/^.*\.fo-page \.form-control.*$/gm) ?? [];

    assert.ok(pageFormRules.length > 0, "precondition: the kit does declare form-control rules");
    assert.ok(pageFormRules.every((rule) => rule.startsWith(":root.fo-dark ")), "and every one of them is dark-qualified");
  });
});
