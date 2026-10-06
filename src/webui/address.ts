/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webui/address.ts: The listed-address rule for plugin settings pages - the form controller addresses are compared in, and whether a saved one is already listed.
 */

/**
 * The listed-address rule a settings page applies before it saves a controller address, so a controller is never listed again under another spelling.
 *
 * An address is compared in its listing form, the host and port it names as the platform URL parser reads it under the scheme the plugin dials, `https` unless
 * the caller names `http`. The module trims the value and drops one trailing dot from the host, and the parser does the rest of the folding: letter case, the
 * scheme's default port, and every IPv6 spelling with or without its brackets all fold to one form, along with whatever else the parser folds, such as IPv4
 * shorthand and an internationalized name's ASCII form. Any other port stays in the form, so a controller reached on its own port is listed apart from the same
 * host bare, and the default port of a scheme the plugin does not dial is a port like any other. Beyond the trim and the dot, this module states only what it
 * refuses and how it joins the host to the port.
 *
 * The rule compares spellings and resolves nothing, so it cannot tell a host name from its IP address, nor see one console reached through more than one port.
 * A value with no form - not a string, empty, carrying a scheme, a path, a query, a fragment or credentials, a zoned IPv6 literal, or text the parser refuses -
 * is never refused as listed, so an exact twin of such a value is accepted, and the plugin's own connection check is what answers it.
 *
 * The module imports nothing at runtime: its one import is the `Nullable` type alias, erased at emit, and the URL parser it uses is a global in the browser and
 * in Node alike, so it is browser-safe. A plugin's page loads the compiled copy the build dual-ships into `dist/ui/`, and a plugin's Node side imports the same
 * rule from the package root.
 *
 * @module
 */
import type { Nullable } from "../util.ts";

/**
 * The scheme a plugin dials its controllers under, whose default port the listing form folds away.
 *
 * @category WebUI Address
 */
export type AddressScheme = "http" | "https";

/**
 * The options {@link addressListingForm} reads.
 *
 * @category WebUI Address
 */
export interface AddressFormOptions {

  /**
   * The scheme the plugin dials the address under, `https` when absent. The form folds away this scheme's default port and keeps every other port.
   */
  readonly scheme?: AddressScheme;
}

/**
 * The options {@link addressListedElsewhere} reads: the address being saved, the page's list of stored addresses, the position the save writes to, and
 * the scheme the plugin dials them under.
 *
 * @category WebUI Address
 */
export interface AddressListedOptions {

  /**
   * The value being saved, as the user entered it. Any value is accepted, and a value with no listing form is never refused as listed.
   */
  readonly address: unknown;

  /**
   * The caller's projection of its own list to each entry's stored address, in list order. An entry that is not a string has no form and matches nothing.
   */
  readonly addresses: readonly unknown[];

  /**
   * The position being saved, or `-1` for an add, as `findIndex` answers.
   */
  readonly index: number;

  /**
   * The scheme the plugin dials the address being saved and every listed address under, `https` when absent, as {@link addressListingForm} reads it.
   */
  readonly scheme?: AddressScheme;
}

// Each spelling the rule tries goes through the parser's own acceptance test first, so text the parser refuses answers null rather than throwing.
function parseAddress(text: string): Nullable<URL> {

  return URL.canParse(text) ? new URL(text) : null;
}

/**
 * The listing form of a controller address: the host the address names, joined to its port when the port is not the default of the scheme the plugin dials.
 * Values with the same form name one controller as far as the rule can see.
 *
 * The value is trimmed and read as the authority of a URL under that scheme, and a value that does not parse there is tried once more inside brackets, so a bare IPv6
 * literal reads as the bracketed one. A value that is not a string, that neither spelling parses, or that carries a path, a query, a fragment or credentials
 * has no form. One trailing dot is removed from the host, and a host left empty by that removal has no form.
 *
 * @param address - The value to read, of any type.
 *
 * @param options - The scheme the plugin dials the address under, `https` when absent.
 *
 * @returns The listing form, or `null` when the value has none. The form is never the empty string.
 *
 * @category WebUI Address
 */
export function addressListingForm(address: unknown, { scheme = "https" }: AddressFormOptions = {}): Nullable<string> {

  if(typeof address !== "string") {

    return null;
  }

  const trimmed = address.trim();
  const url = parseAddress(scheme + "://" + trimmed + "/") ?? parseAddress(scheme + "://[" + trimmed + "]/");

  if(!url) {

    return null;
  }

  // The value must name an authority and nothing else. The trailing slash the spelling appends is the whole path, so a path, a query or a fragment in the value
  // moves it out of place, and an empty query or fragment carries that slash as its text.
  if((url.pathname !== "/") || (url.search !== "") || (url.hash !== "") || (url.username !== "") || (url.password !== "")) {

    return null;
  }

  const host = url.hostname.endsWith(".") ? url.hostname.slice(0, -1) : url.hostname;

  if(host === "") {

    return null;
  }

  return (url.port === "") ? host : host + ":" + url.port;
}

/**
 * Whether the address being saved is already listed at another position, compared by listing form under the scheme the options name.
 *
 * The exact value already stored at `index` is the entry itself, unchanged, so it is never refused, even beside a twin listed elsewhere. Any other value is
 * refused when it has a form and another position holds a value of the same form. A value with no form is never refused, and an add passes `-1`, which no
 * position holds.
 *
 * @param options - The address being saved, the list of stored addresses, the position being saved, and the scheme they are dialed under.
 *
 * @returns `true` when another position already lists the address, otherwise `false`.
 *
 * @category WebUI Address
 */
export function addressListedElsewhere({ address, addresses, index, scheme }: AddressListedOptions): boolean {

  if(addresses[index] === address) {

    return false;
  }

  const form = addressListingForm(address, { scheme });

  if(form === null) {

    return false;
  }

  return addresses.some((listed, position) => (position !== index) && (addressListingForm(listed, { scheme }) === form));
}
