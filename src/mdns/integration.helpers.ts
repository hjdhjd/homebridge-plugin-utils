/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mdns/integration.helpers.ts: Gate predicate for the mDNS browser's differential test suite.
 */

/**
 * Resolves the boolean that gates the mDNS integration suite (`browser-integration.test.ts`). The resolution is sticky: it runs once at module load and the
 * result is reused for every `describe` skip predicate that imports it.
 *
 * There is no autodetection here, for the same reason the hblog gate has none rather than the reason the FFmpeg gate has one. The FFmpeg gate can cheaply probe
 * for a binary on PATH; nothing cheap and synchronous answers whether multicast reaches this host's own socket, which depends on the link, on whether the
 * operating system's own responder holds port 5353, and on whatever a firewall thinks of group traffic. The suite also advertises a service on the real network
 * for the duration of a row, which is a side effect to opt into deliberately rather than to have happen because a probe came back true.
 *
 * The single input is the `MDNS_INTEGRATION` environment variable: exactly `"1"` enables the suite, and anything else - unset, `"0"`, or any other value -
 * leaves it skipped. The default `npm run test` invocation therefore stays free of any network dependency.
 *
 * The predicate is a plain boolean because `describe` evaluates its `skip` option at registration time, not asynchronously. Node's module cache ensures the
 * lookup happens exactly once even if several test files import this helper.
 *
 * Files matching `*.helpers.ts` are excluded from both the compiled `dist/` build emit (see `tsconfig.build.json`) and the TypeDoc API docs output (see
 * `typedoc.json`) so nothing from this module ships in the published npm package or the published documentation.
 *
 * @module
 */
import { env } from "node:process";

/**
 * Resolved at module load time. `true` when the mDNS integration suite should run, `false` when it should be skipped. Driven solely by
 * `MDNS_INTEGRATION === "1"`; there is no autodetection, so the suite is OFF by default. See the module-level documentation for the full resolution rules.
 */
export const mdnsIntegrationEnabled: boolean = env["MDNS_INTEGRATION"] === "1";
