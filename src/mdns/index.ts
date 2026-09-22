/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * mdns/index.ts: mDNS modules.
 */
// A wildcard here would publish isLinkLocal and zoneOf too: address.ts exports both so browser.ts can still import them, but only the ranked pick and the
// membership test are this package's own public surface, so this re-export names them rather than widening to the whole module.
export { dialAddress, isAdvertisedAt } from "./address.ts";
export * from "./browser.ts";
export * from "./discovery.ts";
export * from "./message.ts";
