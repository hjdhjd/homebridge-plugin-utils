# Changelog

All notable changes to this project will be documented in this file.

## 2.3.2 (2026-08-16)
  * Improvement: the live status panel keeps per-device state memory and renders a device's last-known state instantly on selection.
  * Housekeeping.

## 2.3.1 (2026-08-15)
  * Fix: the shared ESLint preset flags undefined identifiers in plain-JavaScript files, which have no TypeScript compiler behind them to catch a mistyped name.
  * Housekeeping.

## 2.3.0 (2026-08-14)
  * Breaking change: a plugin's `infoPanel` hook now receives a single options bag - `infoPanel({ device, panel, signal })` - instead of positional arguments. Named keys can't disagree about argument order the way two positional signatures can, and the bag carries something the old shape had no room for: `signal`, the mount's lifetime. Convert your hook when you rebuild against this release... an unconverted positional hook receives the bag as its first argument and renders nothing rather than failing loudly. `defaultInfoPanel` takes the same shape, so the internal default and the plugin-facing contract are one signature rather than two.
  * Breaking change: the feature-options webUI's `getControllers` hook now resolves `{ controllers, error }` instead of a bare controller array - the same shape `getDevices` adopted in 2.1.0, carrying a connection failure back with the response it belongs to. A reported failure lands on the connection-error view with its retry affordance instead of the "no controllers configured" helper text - two situations whose remedies have nothing in common, and only one of which you can act on from that page. A hook still resolving the bare array fails loudly with an error naming the contract rather than degrading quietly, and the public `refreshControllers()` resolves false on a reported error and leaves the current view standing, since an explicit refresh belongs to the caller that asked for it. Convert your hook when you rebuild against this release.
  * New feature: a live device status panel for the feature-options webUI. Supply a `statusPanel` config and the panel renders your device's live state beside its options - identity rows you define, status rows your server pushes, and per-reason error copy you can override. A companion status protocol module carries the vocabulary, and a server `hello` on restart re-adopts the feed so a helper process that respawns doesn't strand the panel.
  * New feature: link-lost detection for an unresponsive host bridge. When the Homebridge server stops answering, the panel says so plainly and offers a full-line reload action rather than sitting on data that quietly went stale - and it clears itself hands-free the moment a fresh server hello arrives.
  * New feature: shared connection-liveness primitives for plugin webUIs - `withDeadline` bounds an await the host bridge may never settle, `createRequestWatchdog` watches a request that carries no failure plumbing of its own, and `createResumeDetector` notices that the browser froze and woke again. That last one reads a clock rather than trusting `visibilitychange`, which WebKit does not reliably deliver to an embedded settings frame.
  * New feature: `ui.liveness.onResume` on the webUI surface, so your plugin can refresh a poll or re-elicit a feed when the page wakes from an OS freeze - the one liveness event a plugin cannot observe for itself.
  * New feature: the stamped webUI loader recognizes a page pinned to a replaced bundle. The settings frame's document can outlive a plugin rebuild, and a loader that ran again in that window would request files that no longer exist while cached code kept running. It now detects that its content-hashed bundle is gone and presents a plain-language reload prompt instead.
  * New feature: one-call theming for your plugin's own webUI pages. `ui.registerTheming()` dresses a first-run or custom settings page in the same design language as the feature-options page - the design tokens, the themed canvas, and a page kit of classes (`fo-page`, `fo-card`, `fo-monospace`, and an `fo-action` ghost treatment that dresses your own controls like the framework's) - and it follows the host: flip the Homebridge UI's theme and every view retints live, no reload required.
  * New feature: `webUi.epochSignal`, the lifetime of your module copy's claim on the settings window. A plugin holds resources with two different lifetimes and each now has its own signal: scope anything serving the panel on screen to the `signal` your render hook receives, and anything belonging to the module copy itself - a recurring poll, a listener on an object the frame keeps across copies - to `epochSignal`. And you rarely need to touch the signal directly: `ui.on(target, event, handler, options?)` registers a listener already scoped to the epoch - pass your own `signal` and it honors both lifetimes, and a nullish target registers nothing, so a page that declares its controls in markup wires what exists without guarding every call - while `ui.epochBounded(signal)` returns the composed lifetime bare, for anything that consumes a signal rather than a listener. Additive; nothing built against 2.2.0 needs a change.
  * New feature: global-only mode for the feature-options webUI. A plugin that registers a single accessory and evaluates every option globally can now declare `globalOnly` and get the page it actually needs - no device list to navigate, no device scope to flip between, and the info panel and options table spanning the vacated width.
  * New feature: feature option entries can declare the scope levels they belong to - `scopes: [ "controller", "device" ]` on the catalog entry - and the declaration is enforced everywhere the framework speaks for an option: resolution walks only declared levels, each view of the options page offers only what its declaration admits, and the click machinery predicts inheritance through the same declaration it resolves by. An entry that declares nothing behaves exactly as it always has, everywhere - declaring is opt-in, per option.
  * New feature: secret feature options. Declare `secret: true` on a value option and the settings page renders its value masked - dots, not text - with browser autofill kept out of the field and an eye control beside it that reveals and re-masks the value on demand. A row that locks returns behind the mask, so a value you can no longer edit is also one a passerby cannot read. Entirely opt-in: an option that declares nothing renders exactly as it always has. The value still lands in your config as plain text like every other option...this guards against reading over your shoulder at the settings page, not secrecy at rest.
  * New feature: plugin-composed device links in the feature-options sidebar. Supply a `sidebar.deviceContent` hook and your plugin decides what a device's sidebar link renders - a badge, a status glyph, a styled composition - falling back to the plain device name for any device you leave alone. The framework keeps the link itself: identity, click handling, and highlighting stay its business, so your content is purely presentational.
  * New feature: a plugin-suppliable refresh action on the feature-options sidebar. Declare `sidebar.refresh` with a label and a handler and the framework docks a refresh control on the device list's heading - glyph, accessibility, in-flight disabling, and page re-entry are all its business; your handler just invalidates whatever your device list caches.
  * New feature: the connection-error view hosts an optional plugin panel. Supply `connectionErrorPanel` and your plugin renders its own guidance beside the failure - the bag carries the controller that failed, when one did - while the framework keeps the retry affordance. Boot failures land there too: the page selects its initial controller the same way a click does, so a controller that fails during boot arrives carrying the controller it belongs to.
  * New feature: the feature-options page shows a connecting affordance while it boots - the copy is yours via `connectingMessage` - instead of a blank frame, and plugin chrome marked `data-fo-region` joins the page's hide-and-reveal, so your own sidebar controls never float alone over an empty page.
  * New feature: an `onOptionsEdited` notification hook, invoked after the store has transitioned for any option mutation, so a consumer reading `editedConfig` from inside the callback sees the post-edit state.
  * New feature: a public controllers-refresh entry point on the feature-options webUI, so a plugin can refresh its controller list without re-entering the whole show cycle.
  * New feature: a supported way to enumerate a feature option's configured entries. `enumerateConfiguredEntries` yields each entry addressing an option - the scope it names in the casing the user wrote it, whether it enables or disables, and the value it carries - decoded through the engine's own grammar. A plugin discovering which scopes its users configured no longer re-reads the storage format by hand, so it cannot drift when the grammar grows.
  * New feature: the canonical MQTT configuration surface. `mqttFeatureOptions` returns the broker-URL and topic feature options every MQTT-bearing plugin has been declaring by hand - spread them into your catalog and your plugin speaks the family convention by construction - and `createMqttClient` builds the client from the resolved configuration, returning `null` when no broker is configured so an MQTT-less install never constructs one. Declaring MQTT becomes one line on each side: the options into your catalog, the client from your config.
  * New feature: a sparkline trend-strip primitive for plugin webUIs. Points in, an area-and-line strip out, drawn in `currentColor` so it wears whatever your container wears, with a conveyor-slide update that respects reduced-motion and a pure trend helper that reports rising, falling, or steady against a deadband you choose.
  * New feature: `setAccessoryName`, the accessory-level sibling of `setServiceName`. One call renames an accessory everywhere it carries a name - the display names and the information service's characteristics - from a single sanitized source, so a rename can never leave an accessory answering to two names. A name with nothing left after sanitizing is not applied anywhere: an accessory has to answer to something.
  * New feature: `sameEntries`, an entry-wise array comparator built for persist-on-change: two arrays, your equality for a single pair, strict handling when an entry is missing on one side. A plugin deciding whether anything actually changed before writing state gets one vetted answer instead of another hand-rolled loop.
  * New feature: `RateBudget`, a signal-aware sliding-window rate limiter for pacing outbound work against a budget - so many operations per interval. Callers `acquire()` a grant and wait their turn when the window is spent, and a caller that gives up passes its own signal and consumes no slot. Built for cloud APIs that meter you by the hour and remember it when you forget.
  * New feature: `superviseStream`, the result-carrying sibling of `superviseLoop`. Where `superviseLoop` supervises a loop that produces nothing, `superviseStream` wraps a source that yields values - `for await` its readings and the same supervision contract holds: quiet when the stream ends or its signal tears down, one honest report on a genuine fault.
  * New feature: a `homebridge-plugin-utils/polyfills` entry point carrying the explicit-resource-management bridge - `DisposableStack`, `AsyncDisposableStack`, and `SuppressedError` - so a plugin adopting `using` semantics on the library's Node 22 floor needs no third-party shim.
  * Improvement: value-centric feature options now carry their value behind an `=` delimiter - `Enable.Option=value` globally, `Enable.Option.id=value` at a scope - and the value is free-form text at every scope: periods, interior spaces, even `=` itself, with whitespace tolerated around the delimiter so a hand-spaced entry reads the same as a tight one. The dotted legacy forms keep parsing exactly as they always did, and a configuration modernizes itself into the `=` form as you save edits. Entries written with `=` read as inert on earlier releases.
  * Improvement: value-option fields rest locked and unlock through their checkbox - arming the row is the deliberate gesture that opens the field, so a stray click can no longer edit a value it never meant to touch - and for a value-centric option, entering a value is itself the enabling gesture: type into the field and the option turns on carrying it. An armed row also survives a window-focus departure, so flipping to another app doesn't discard the edit you were mid-way through.
  * Improvement: pending feature-option edits commit and persist when focus leaves the webUI - switching apps or tabs flushes the same way navigating away always has, so an edit made moments before a distraction still reaches your config.
  * Improvement: every await the feature-options page makes during boot is now deadline-bounded, and every failure routes into the existing connection-error retry. A dead host bridge can no longer strand a blank settings page behind an await that never settles - you get the retry affordance instead.
  * Improvement: a superseded copy of your webUI now retires itself. The settings frame is reused across panel opens and each open loads a fresh copy of your module, so an abandoned copy's timers, listeners, and menu handlers would go on running against a page the newest copy owns. Construction now claims the window and stands the predecessor down whole.
  * Improvement: menu tabs draw their active state from the theme's accent - the active tab wears the accent fill, inactive tabs a mode-aware ghost - and they hold those colors through hover, focus, and press in both light and dark modes.
  * Improvement: the Global Options entry presents as a navigable row - the sidebar's heading type, a globe glyph (yours to swap via `sidebar.globalGlyph`), a resting outline, and the same hover and selection treatment as every other destination - rather than a section header pretending not to be clickable.
  * Improvement: value option fields - masked secret fields included - wear the dark form-control treatment in dark mode instead of glaring white.
  * Improvement: plugin-suppliable controller-failure guidance. Set `ui.controllerFailureGuidance` and the connection-error view speaks your topology's language everywhere a controller failure surfaces, instead of one-size-fits-nobody copy.
  * Improvement: one shared recovery button and one failure-text color source across the webUI, so every failure surface looks and behaves the same way.
  * Improvement: the feature-options sidebar width is now the `--fo-sidebar-width` design token, so a plugin anchoring its own chrome to the sidebar references the token instead of mirroring the number.
  * Improvement: `TimerRegistry` can drain every pending timer on demand while staying armed for later registrations, so a mid-lifecycle reset no longer means tearing the registry down and building a new one.
  * Improvement: the timing of an FFmpeg process's failure classification is now a documented contract - the classification is final and readable the moment your abort listener runs, so shutdown logic may rely on that ordering rather than treating it as an implementation accident.
  * Fix: committing an empty value for a feature option clears the option's entry rather than leaving a stale value behind.
  * Fix: unchecking a value-centric feature option that defaults to off clears the option's entry rather than leaving behind an explicit disable that only restates the default.
  * Fix: the feature-options table renders inert - dimmed and unclickable - while a controller's device list loads, so a click in that window can no longer record an option at the wrong scope.
  * Fix: switching views quickly can no longer leave an expanded feature-option category showing empty...an open category now always fills in on the page's next update.
  * Fix: a controller's options page presents at controller scope - the header, the scope coloring, and the inheritance display all agree with the write machinery now, including for controllers whose device list reports a different identity than their sidebar entry.
  * Fix: hardware-accelerated transcoding with caller-supplied video filters no longer fails at the macOS VideoToolbox upload - the pixel-format conversion runs ahead of the hardware handoff, so your filters and the hardware path compose on every platform.
  * Fix: the webUI's menu listeners are registered once across repeated show cycles, rather than stacking a fresh set on every re-entry.
  * Housekeeping.

## 2.2.0 (2026-07-19)
  * New feature: `prepare-ui` now stamps your plugin's webUI script loader into `index.html` as a marked, regenerated region - declare your plugin name in a config comment once and every rebuild keeps the loader current (content-hashed library path included), so the snippet can't drift from the shell it loads.
  * New feature: the stamped webUI loader region now reports its own boot failures on the page. When the settings interface can't start - an unsupported browser, files that won't download from the Homebridge server, or an unexpected error - you get a plain-language message and a screenshot-ready technical-details panel instead of a blank white page, and a boot that simply hangs raises a "taking longer than expected" notice after ten seconds. The panel stands down the instant the interface renders, so a healthy load never shows it.
  * New feature: `prefixedLog`, a pass-through prefixed logging factory. It prefixes every line through a live supplier - so a renamed device shows its new name immediately - while passing parameters straight through to your base logger, which formats once behind its own gate: a disabled debug log never pays for formatting.
  * New feature: `TimerRegistry`, a lifecycle-scoped keyed timer registry. A keyed registration replaces the pending timer under the same key, anonymous one-shots schedule alongside, and every pending timer drains automatically when the registry's `AbortSignal` fires - so a torn-down accessory can't leak timers or fire into dead state.
  * Improvement: the fMP4 test-construction builders are now published on the package's main surface, so a consumer plugin can assemble valid initialization and media fragments in its own tests instead of hand-rolling binary fixtures.
  * Improvement: `FfmpegOptions.hardwareEncodes()` is now public - it reports whether a transcode context runs on the host's hardware encoder in the resolved configuration, so a consumer's narration and policy can key on the same decision the encoder selection itself uses.
  * Improvement: `videoFilters` on the video encoder options - supply your own CPU-side filters (motion interpolation, for example) and the stream and record encoders splice them into the composed filter chain on every platform path, handling the GPU-resident download handoff for you so a hardware-accelerated session and your filters no longer conflict.
  * Improvement: the feature options webUI now decides device-list staleness in the store itself for every dispatcher - including a re-click of the same controller racing its own earlier fetch - so a late result can never overwrite the newest view.
  * Improvement: a configuration sync failure when entering the feature options page now lands on the connection-error view with its retry path, instead of leaving a blank frame behind a toast.
  * Improvement: a documentation-index entry can now opt out of the stamped footer chrome (`footer: false`), matching the masthead opt-out - with both opted out, a linked file such as a changelog stays entirely free of stamped chrome while remaining listed in every documentation index.
  * Improvement: the shared TypeScript config base now resolves `homebridge` and `@homebridge/hap-nodejs` types to your plugin's own installed copies. When you develop against a symlinked homebridge-plugin-utils whose tree pins different homebridge or hap-nodejs versions, the HAP types no longer split into two incompatible identities and flood your editor with false type errors - version skew surfaces only as genuine API incompatibilities, exactly as it would in a published install.
  * Housekeeping.

## 2.1.0 (2026-07-13)
  * Breaking change: the feature options webUI's `getDevices` hook now resolves `{ devices, error }` instead of a bare device array, carrying a connection failure back with the response it belongs to. The `/getErrorMessage` side-channel convention is gone, closing a race where rapid controller switches could show one controller's error under another. The webUI also discards a superseded controller click's late result rather than letting it overwrite the newest view, and a failed re-entry into the feature options page - from the menu or the connection-error retry - surfaces as an error toast rather than vanishing. The default Homebridge accessory-cache device source resolves the same shape, so device-only plugins need no changes.
  * New feature: the CLI's `prepare-docs` can now generate your plugin family's shared documentation chrome - the masthead and documentation index across your README, docs, and webUI support page - from a single manifest, so the common elements can't drift between plugins.
  * New feature: `guardedDispatch` wraps the async handlers HomeKit invokes without awaiting, so a failure inside them is contained and reported instead of escaping as an unhandled rejection.
  * New feature: the fMP4 assembler and recording process surfaces now expose a tagged segment stream that distinguishes the initialization segment from media segments, so a consumer can route each without re-parsing.
  * Improvement: a failed first-run submit in the webUI now surfaces as an error toast, whether the failure lands before the page swap (you stay on the first-run form) or after it (the main shell stays usable).
  * Fix: restored Node 22 compatibility to RTP port reservation with an internal `DisposableStack` implementation.
  * Housekeeping.

## 2.0.0 (2026-07-07)
  * Breaking change: the feature options web UI has been rebuilt on a new reactive architecture, and its internal module files were reorganized (the old `webUi-featureoptions-*.mjs` files are gone). It re-reads the host configuration when you open it, so a change made on the Settings tab is reflected on return, and it flushes any pending edit when you leave, so a toggle made right before navigating away still reaches the config. Just re-run `prepare-ui` to mirror the new files into your plugin; only a plugin that loaded those individual module files by name needs to update.
  * Breaking change: `FeatureOptions.color()` has been removed. The web UI now derives its scope-based coloring internally, so the method had no remaining callers. If you called it directly, resolve the scope with `FeatureOptions.scope()` and map it to your own class.
  * Breaking change: the FFmpeg, RTP, MQTT, and backpressure classes are now constructed from a single options object instead of positional arguments. `FfmpegProcess`, `FfmpegStreamingProcess`, `FfmpegExec`, `FfmpegRecordingProcess`, `FfmpegLivestreamProcess`, and `RtpDemuxer`, along with `MqttClient`, `BackpressureWriter`, and `RtpPortAllocator.reserve()`, now take one `init`/config object whose named fields replace the old positional parameters.
  * Breaking change: long-lived objects now spawn on construction and tear down through `AbortSignal` and `AsyncDisposable` rather than imperative start/stop/close. `FfmpegProcess.start()`/`stop()`, `FfmpegLivestreamProcess.start()`, `RtpDemuxer.close()`, `BackpressureWriter.close()`, and `RtpPortAllocator.cancel()` are gone - construct the object (it starts immediately), pass an `AbortSignal` to cancel it, and manage its lifetime with `await using` (or call `abort()`). `FfmpegProcess` and `RtpDemuxer` are no longer `EventEmitter`s: await their `ready`/`exited`/`mediaReady` promises instead of subscribing to events, and `BackpressureWriter.write()` is now `async`.
  * Breaking change: `FfmpegCodecs` is now built through the static factories `FfmpegCodecs.probe()` and `FfmpegCodecs.fromState()` instead of `new FfmpegCodecs(options)` plus an instance `probe()`. The constructor is private, and `probe()` resolves to a ready `FfmpegCodecs` (or `null`) rather than a boolean.
  * Breaking change: several FFmpeg members were renamed or removed. `FfmpegExec.exec()` is now `result()` (its input moves to `init.stdin` and the result shape changed); `FfmpegRecordingProcess.segmentGenerator()` is now `segments()`; `FfmpegOptions.codecSupport` is gone (read `ffmpegOpts.config.codecSupport`); and `FfmpegOptions.hostSystemMaxPixels` is replaced by the context-aware `maxSourcePixels(context)` accessor, which reports the hardware-encode pixel ceiling based on the actual session rather than the host alone. The `FfmpegStreamingProcess.ffmpegProcess`, `FfmpegLivestreamProcess.initSegment` (use `getInitSegment()`), and `RtpDemuxer.socket`/`isRunning` accessors were also removed.
  * Breaking change: `MqttClient` methods no longer take a leading device-id argument. `publish()`, `subscribe()`, `subscribeGet()`, and `subscribeSet()` drop the `id` parameter (and `subscribeGet`/`subscribeSet` drop the trailing `log`); `publish()` is now `async`.
  * Breaking change: `retry()` has a new signature - its operation receives an `AbortSignal` and must throw to signal failure (returning `false` no longer means "failed"), its second argument is an options object rather than a numeric interval, and it resolves to your operation's value (`Promise<T>`); it also gained an optional `shouldRetry` predicate and unbounded-attempt support. The `sleep()` and `runWithTimeout()` helpers have been removed in favor of the signal-aware wait primitives.
  * New feature: `hblog`, a zero-dependency log-tailing tool for `homebridge-config-ui-x`. Use it from the command line (`hblog -f` live-tails the log; `-n N`/`--all` pull history; `-p`/`-g`/`-l` filter by plugin, grep, or level; `--since`/`--until` restrict output to a time window; `--json` emits NDJSON) or programmatically via `import { HomebridgeLogClient } from "homebridge-plugin-utils"` for an `AsyncDisposable` client whose `history()`, `follow()`, and `tail()` channels stream parsed log records. The live tail rides the UI's Socket.IO stream (cheap, incremental, with automatic reconnect and ping-liveness), and deep history falls back to a one-shot whole-file download only when you explicitly ask for it. Connection settings come from flags, the `HBLOG_*` environment variables, or an optional `~/.hblog.json`.
  * New feature: a `homebridge-plugin-utils` command-line tool with two subcommands. `prepare-ui` mirrors the compiled web UI into your plugin's `homebridge-ui/public/lib` under a content-hashed, versioned folder, so the browser never serves a stale cached copy after you rebuild. `prepare-docs` regenerates your plugin's Feature Options reference straight from its catalog, so the docs can't drift from the options you actually ship.
  * New feature: `superviseLoop` runs a detached, signal-bound async loop and keeps it honest - it stays quiet when the loop ends or its signal is torn down, and hands a genuine failure to your error handler exactly once, so the same resilient background-loop boilerplate no longer has to be hand-copied (and quietly drift) across a plugin.
  * New feature: `loopFaultReporter` is the ready-made `superviseLoop` error handler - hand it your logger and a label and drop it straight into `onError`, and a faulted loop is reported with one consistent, operator-friendly message (formatted through `formatErrorMessage`) instead of every plugin spelling out its own.
  * New feature: `FeatureOptions.logFeature()` emits your plugin's startup feature log with one consistent convention - it reports a feature only when it deviates from its default (in either direction) and stays silent otherwise, and it renders values through a shared, named formatter registry (`bps`, `kbps`, `bytes`, `percent`, `ms`, `seconds`) so every plugin shows bitrates, sizes, and durations the same way. The underlying magnitude formatters are exported on their own too (`formatBps`, `formatBytes`, `formatMs`, `formatPercent`, `formatSeconds`).
  * New feature: homebridge-core and HAP const enums are now mirrored at runtime, so you can value-access them under `verbatimModuleSyntax` without a separate import - `APIEvent` (for example `APIEvent.DID_FINISH_LAUNCHING`) plus the full camera-plugin HAP surface (audio and video codec types, sample rates, H.264 level and profile, SRTP suites, and more).
  * New feature: an injectable `Clock` time seam, with a `TestClock` double, so time-dependent code can be tested deterministically instead of waiting on the wall clock.
  * New feature: a shippable `noOpLog` no-op logger, for code paths that need a concrete logger but want no output.
  * New feature: `capabilityGate` builds a `validService` predicate for a service gated on both a hardware capability and a user toggle. It applies an additive-eager, subtractive-conservative asymmetry - a disabled toggle always removes the service, while a transient capability-false keeps an existing service rather than dropping it, and a new service is added only once the capability reports. Pass the result straight to `validService`.
  * New feature: the package now ships an explicit `exports` map defining its public surface, so imports resolve through stable, documented entry points rather than reaching into internal files.
  * New feature: a shippable `@hjdhjd` ESLint preset you can extend with `homebridge-plugin-utils/eslint`. It carries a small set of in-house rules under the `@hjdhjd` namespace, including the `@hjdhjd/comment-style` enforcement rule that keeps comments grep-able and rendering-stable, with autofixes for Unicode-glyph drift, em-dashes, decorative banners, and box-drawing characters.
  * Improvement: two-way audio (talkback) now forwards RTP and RTCP over a single socket with source-port symmetry and a built-in RTCP keepalive heartbeat, which keeps FFmpeg's audio input alive through the quiet stretches of a two-way call.
  * Improvement: RTP and streaming return sockets can now bind to a kernel-assigned ephemeral port, eliminating a reserve-then-rebind race that could occasionally collide on a busy host.
  * Improvement: compatibility with Homebridge 2.0.
  * Improvement: the TypeScript build configuration has been modernized - it now emits source maps and declaration maps so you can step into and jump to `homebridge-plugin-utils` source while developing against it locally (the declaration maps are stripped from the published package to keep the tarball lean), and its relative-import handling lets the source run directly under Node's type-stripping while the published files keep fully-resolvable specifiers.
  * Fix: `getServiceName` is now a pure read - it no longer lazily attaches the name characteristics as a side effect of reading the name.
  * Fix: a cold-start stream is no longer torn down before its first return packet arrives; the streaming inactivity watchdog now arms on the first inbound packet rather than at startup.
  * Housekeeping.

## 1.35.0 (2026-04-07)
  * New feature: `BackpressureWriter`, a backpressure-aware write queue that handles the full serialize-write-pause-drain dance for you when feeding data into writable streams - handy for piping fMP4 segments into FFmpeg without drowning it.
  * New feature: `hasAudioTrack` inspects an fMP4 initialization segment and tells you whether it contains an audio track, which is useful for deciding whether to wire up audio on the FFmpeg command line at all.
  * Improvement: fMP4 box parsing in HKSV recording and livestreaming is now faster and shares its plumbing with the standalone fMP4 utilities, so the two parsers can't drift apart.
  * Improvement: `FfmpegProcess.hasError`, `isEnded`, and `isStarted` are now formally read-only. Reading them works as it always did - we're just making the existing "please don't touch these" contract enforceable by the compiler.
  * Improvement: `FfmpegOptions.codecSupport` is now read-only, because there's no reason anyone should ever be reassigning it after construction.
  * Improvement: `RtpPortAllocator` no longer gets stuck in an infinite loop when asked for a specific port that's already reserved. It now cleanly reports failure so the caller can retry.
  * Improvement: `retry()` is now an iterative loop rather than a recursive call chain. Same behavior, clearer control flow.
  * Improvement: `validateName` compiles its regex once at module scope, giving the `sanitizeName` fast path a little more pep.
  * Improvement: codec probing accumulates decoder and encoder sets cleanly even if a codec appears on multiple lines, and probing failures no longer double-log when FFmpeg isn't in your path.
  * Improvement: error messages in MQTT and codec probing no longer end with double periods when the underlying error message already includes one.
  * Housekeeping.

## 1.34.0 (2026-04-04)
  * Breaking change: `toCamelCase` has been removed. Use `toStartCase` instead - the new name accurately reflects the function's behavior of capitalizing every word unconditionally.
  * Breaking change: `FfmpegProcess.process` is no longer publicly accessible. Use the `stdin`, `stdout`, `stderr` getters, or `FfmpegStreamingProcess.ffmpegProcess` for process-level access.
  * Behavior change: `sleep` now returns `Promise<void>` instead of `Promise<NodeJS.Timeout>`. No consumer should be affected since the resolved value was never meaningful.
  * Improvement: feature option lookups are now significantly faster, using an indexed approach that resolves options in constant time rather than scanning the full configuration on every query.
  * Improvement: fMP4 recording and livestreaming now share a cleaner internal architecture, with audio filter, video filter, and audio transcoding options available to both recording and livestream sessions.
  * Improvement: FFmpeg process stream handling is now more robust, with improved error reporting, more accurate process lifecycle detection, and better protection against edge cases in fMP4 box parsing.
  * Fix: MQTT unsubscribe now correctly notifies the broker to stop sending messages for the topic, rather than only removing the local callback.
  * Housekeeping.

## 1.33.0 (2026-03-20)
  * New feature: fMP4 box parsing utilities for locating ISO BMFF boxes, detecting keyframe segments, and splitting moof/mdat components.
  * Improvement: expose hardware download filters for use outside the encoder pipeline.
  * Housekeeping.

## 1.32.0 (2026-02-14)
  * New feature: add separate audio input support for fMP4 livestreaming, enabling devices like DoorBird where video and audio are served from different endpoints.
  * Improvement: modernize ESLint configuration for ESLint 10 readiness.
  * Housekeeping.

## 1.31.0 (2026-01-24)
  * Fix: address an issue where certain service types were not correctly identified for Name characteristic support.
  * Fix: resolve an issue where FFmpeg command execution could hang indefinitely when process creation failed.
  * Fix: ensure codec detection methods return correct boolean values when a codec is not found.
  * Improvement: additional linting rules.
  * Improvement: optimized service UUID lookups with cached Sets for O(1) performance.
  * Housekeeping.

## 1.30.0 (2026-01-10)
  * Improvement: additional linting rules.
  * Housekeeping.

## 1.29.5 (2025-12-31)
  * Housekeeping.

## 1.29.4 (2025-11-24)
  * Housekeeping.

## 1.29.3 (2025-09-15)
  * Housekeeping.

## 1.29.2 (2025-09-05)
  * Housekeeping.

## 1.29.1 (2025-09-01)
  * Housekeeping.

## 1.29.0 (2025-09-01)
  * Improvement: additional linting rules.
  * Improvement: CPU generation detection now encompasses Apple Silicon as well Intel CPUs. `intelGeneration` has now become `cpuGeneration` as a result, but the semantics are identical.
  * Improvement: modernized the hardware acceleration pipeline to utilize hardware scaling whenever possible (and working correctly) and prepared for the future including FFmpeg 8.0 support.
  * Improvement: added audio and video filter support to HKSV event recording.
  * Improvement: the feature option webUI now maintains the context of what category groups you've left expanded and collapsed.
  * Housekeeping.

## 1.28.0 (2025-08-24)
  * Improvement: additional linting rules.
  * Improvement: refinement to FFmpeg-related functions.
  * Housekeeping.

## 1.27.2 (2025-08-11)
  * Improvement: additional linting rules.
  * Housekeeping.

## 1.27.1 (2025-08-09)
  * Fix: ensure we honor Homebridge Config UI X's lighting theme overrides.
  * Housekeeping.

## 1.27.0 (2025-08-08)
  * Breaking change: feature option webUI has been completely rewritten and enhanced to support Homebridge Config UI's theming, a more responsive UI, search, and other fun goodies.
  * Improvement: value-centric feature options can specify their size so they render in a more user-friendly manner.
  * Improvement: additional linting rules.
  * Housekeeping.

## 1.26.1 (2025-07-26)
  * Housekeeping.

## 1.26.0 (2025-07-15)
  * Fix: address a regression in `validateName`.
  * Improvement: minor improvements to FFmpeg processing.
  * Housekeeping.

## 1.25.0 (2025-07-06)
  * Behavior change: `acquireService` will no longer attempt to rename a service if it's already been created. To get or set a service's user-visible name, use `getServiceName` and `setServiceName`.

## 1.24.0 (2025-07-05)
  * Behavior change: `validateName` is now `sanitizeName`.
  * New feature: `getServiceName` and `setServiceName` will get or set a service's user-visible name.
  * Improvement: A new `validateName` function that returns whether or not a name meets HomeKit naming rules.
  * Improvement: `acquireService` no longer requires a HAP context object. It will derive it from the service instead.
  * Improvement: added matching semantics to `audioEncoder` to mirror `videoEncoder` and better future-proof it. `EncoderOptions` are now `VideoEncoderOptions` as well.
  * Housekeeping.

## 1.23.0 (2025-06-17)
  * Improvement: added `intelGeneration` for better CPU detection of Intel CPU capabilities, particularly as it relates to AV1.
  * Improvement: AV1 decoding will be disabled if an Intel CPU below the 11th generation, since they don't have AV1 decoding available.
  * Housekeeping.

## 1.22.0 (2025-06-14)
  * Improvement: added AV1 support for decoding in FFmpeg.
  * Improvement: exposed the `start` method and the underlying `ChildProcess` in `FfmpegProcess` for use by consumers.
  * Housekeeping.

## 1.21.1 (2025-06-02)
  * Improvement: adjust `audioEncoder` semantics when we use `aac_at` to use `cbr` rather than `cvbr` for better HomeKit compatibility especially in very low bitrate scenarios.
  * Housekeeping.

## 1.21.0 (2025-06-01)
  * Improvement: evolved `audioEncoder` semantics to support multiple encoding types (AAC_LC and AAC_ELD).
  * Improvement: added additional semantics to `FfmpegRecordingProcess` and `FfmpegLivestreamProcess`.
  * Housekeeping.

## 1.20.0 (2025-05-31)
  * Improvement: evolving FFmpeg-related semantics for better future-proofing and growth. Now includes the ability to specify which audio and video stream to use when recording or segmenting into a livestream.
  * Fix: address audio sync issues when recording HKSV events.
  * Housekeeping.

## 1.19.0 (2025-05-29)
  * Improvement: added additional semantics to `videoEncoder` to address QSV-specific use cases.
  * Housekeeping.

## 1.18.0 (2025-05-27)
  * Improvement: added additional semantics to `validService`.

## 1.17.0 (2025-05-26)
  * Improvement: added options to selectively enable verbosity on specific FFmpeg recording or livestream instances.
  * Improvement: evolved semantics for FFmpeg recording to specify what the input codec is to better support hardware acceleration scenarios.
  * Housekeeping.

## 1.16.0 (2025-05-18)
  * New feature: FFmpeg process utilities, including well-tested capabilities that provide livestreaming, HomeKit Secure Video (HKSV) event recording, and more. These capabilities were ported over and enhanced from my existing [Homebridge UniFi Protect](https://github.com/hjdhjd/homebridge-unifi-protect) plugin.
  * Improvement: significant documentation updates.
  * Fix: address a minor issue in value-centric feature option detection.
  * Housekeeping.

## 1.15.3 (2025-03-16)
  * Housekeeping.

## 1.15.2 (2025-03-16)
  * Housekeeping.

## 1.15.1 (2025-03-16)
  * Housekeeping.

## 1.15.0 (2025-03-16)
  * New feature: `formatBps` to format bitrates to bps, kbps, and Mbps.
  * Housekeeping.

## 1.14.0 (2025-01-05)
  * New feature: `toCamelCase` to camel case a string.
  * Housekeeping.

## 1.13.0 (2024-12-23)
  * Behavior change: don't show the first run screen if there are no devices, but the user has configured everything they needed to.
  * Housekeeping.

## 1.12.0 (2024-12-21)
  * Improvement: remove support for anything below Node 20 and optimize for Node 20 and above.
  * Housekeeping.

## 1.11.3 (2024-12-08)
  * Fix: minor regression in `retry`.
  * Housekeeping and documentation updates.

## 1.11.2 (2024-12-08)
  * Minor fixes and enhancements.
  * Housekeeping.

## 1.11.1 (2024-12-07)
  * Minor fixes and enhancements.
  * Housekeeping.

## 1.11.0 (2024-12-07)
  * Breaking change: `serial` is now `serialNumber` in the feature option webUI configuration to be consistent with the `SerialNumber` characteristic in Homebridge/HomeKit.
  * Behavior change: value-centric feature options can now be explicitly disabled like binary feature options. `null` will be returned when a value-centric feature option has been disabled.
  * Behavior change: the feature option webUI now handles value-centric feature options like binary feature options, with the ability to explicitly disable them.
  * Housekeeping.

## 1.10.2 (2024-10-14)
  * Housekeeping.

## 1.10.1 (2024-10-12)
  * Housekeeping.

## 1.10.0 (2024-10-12)
  * New feature: `Nullable` as a template utility type.
  * Housekeeping.

## 1.9.0 (2024-09-29)
  * New feature: `validateName` to ensure a proper HomeKit name.
  * Improvement: `acquireService` will now filter names through `validateName` as well.
  * Housekeeping.

## 1.8.2 (2024-09-22)
  * Housekeeping.

## 1.8.1 (2024-09-14)
  * Housekeeping.

## 1.8.0 (2024-09-14)
  * Improvement: additional typechecking.

## 1.7.0 (2024-08-04)
  * Update to ESlint v9.
  * Housekeeping.

## 1.6.1 (2024-07-22)
  * Housekeeping.

## 1.6.0 (2024-07-20)
  * New feature: added `acquireService` and `validService` functions to allow for convenient service creation, retrieval, naming, and validation.
  * Improvement: additional linting rules.
  * Housekeeping.

## 1.5.0 (2024-06-14)
  * New feature: added `runWithTimeout` function to allow the arbitrary execution of a promise with a guaranteed timeout.

## 1.4.0 (2024-06-06)
  * Improvement: additional typechecking.

## 1.3.0 (2024-06-03)
  * New feature: added a limit option to the retry utility function.

## 1.2.0 (2024-06-01)
  * New feature: full two-level configuration is now available via the webUI. You can now more fully configure feature option webUIs like the ones used in [homebridge-unifi-protect](https://github.com/hjdhjd/homebridge-unifi-protect) to simpler ones like the ones used in [homebridge-hunter-hydrawise](https://github.com/hjdhjd/homebridge-hunter-hydrawise) and [homebridge-ratgdo](https://github.com/hjdhjd/homebridge-ratgdo).
  * New feature: added a robust UDP port allocator and manager to allow you to safely reserve and use UDP ports within Node. This is necessary in Homebridge in part because FFmpeg does not let you specify the port numbers for both the data and control channels in it's RTP support - they must be consecutive. This necessitates a port manager like `RtpPortAllocator` to allocate and manage UDP port reservations across your plugin to ensure there are no conflicts. This problem is really only encountered in the scenario where you have return audio (aka two-way audio) requirements, such as for a doorbell where the HomeKit client app needs to send audio back to the doorbell.
  * New feature: added RTP demuxer capabilities since FFmpeg does not currently support RFC 5761 (multiplexing RTP data and control packets on a single port) and HomeKit requires this for two-way audio capabilities.
  * New feature: added various TypeScript utility types like DeepPartial and DeepReadonly.
  * Improvement: added a show method on the webUi class to separate instantiation from UI rendering.
  * Improvement: added a color method to the feature options class to provide additional visual context to option scope and hierarchy.
  * Improvement: further refinements to our linting rules to ensure consistency across plugins.
  * Housekeeping.

## 1.1.0 (2024-05-20)
  * New feature: added optional firstRunInit, firstRunRequired, and firstRunSubmit handlers for additional customization in the firstRun workflow.
  * New feature: globals are now shared for eslint.
  * Housekeeping.

## 1.0.0 (2024-05-18)
  * Initial release with support for feature options, feature option webUI, plugin MQTT client support, and common linting and build scripts.
