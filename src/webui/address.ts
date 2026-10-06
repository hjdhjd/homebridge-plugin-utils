/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webui/address.ts: The listed-address rule for plugin settings pages - the form controller addresses are compared in, and whether a saved one is already listed.
 */

/**
 * The listed-address rule a settings page applies before it saves a controller address, so a controller is never listed again under another spelling.
 *
 * An address is compared in its listing form, the host and port it names as the platform URL parser reads it. The parser does the folding: every value is parsed
 * under `https`, so surrounding space, letter case, the HTTPS default port, every IPv6 spelling with or without its brackets, and a trailing dot on a name all
 * fold to one form, along with whatever else the parser folds, such as IPv4 shorthand and an internationalized name's ASCII form. A port other than the default
 * stays in the form, so a controller reached on its own port is listed apart from the same host bare. This module states only what it refuses and how it joins
 * the host to the port.
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
 * The options {@link addressListedElsewhere} reads: the address being saved, the page's list of stored addresses, and the position the save writes to.
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
}

// Each spelling the rule tries goes through the parser's own acceptance test first, so text the parser refuses answers null rather than throwing.
function parseAddress(text: string): Nullable<URL> {

  return URL.canParse(text) ? new URL(text) : null;
}

/**
 * The listing form of a controller address: the host the address names, joined to its port when the port is not the HTTPS default. Values with the same form
 * name one controller as far as the rule can see.
 *
 * The value is trimmed and read as the authority of an `https` URL, and a value that does not parse there is tried once more inside brackets, so a bare IPv6
 * literal reads as the bracketed one. A value that is not a string, that neither spelling parses, or that carries a path, a query, a fragment or credentials
 * has no form. One trailing dot is removed from the host, and a host left empty by that removal has no form.
 *
 * @param address - The value to read, of any type.
 *
 * @returns The listing form, or `null` when the value has none. The form is never the empty string.
 *
 * @category WebUI Address
 */
export function addressListingForm(address: unknown): Nullable<string> {

  if(typeof address !== "string") {

    return null;
  }

  const trimmed = address.trim();
  const url = parseAddress("https://" + trimmed + "/") ?? parseAddress("https://[" + trimmed + "]/");

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
 * Whether the address being saved is already listed at another position, compared by listing form.
 *
 * The exact value already stored at `index` is the entry itself, unchanged, so it is never refused, even beside a twin listed elsewhere. Any other value is
 * refused when it has a form and another position holds a value of the same form. A value with no form is never refused, and an add passes `-1`, which no
 * position holds.
 *
 * @param options - The address being saved, the list of stored addresses, and the position being saved.
 *
 * @returns `true` when another position already lists the address, otherwise `false`.
 *
 * @category WebUI Address
 */
export function addressListedElsewhere({ address, addresses, index }: AddressListedOptions): boolean {

  if(addresses[index] === address) {

    return false;
  }

  const form = addressListingForm(address);

  if(form === null) {

    return false;
  }

  return addresses.some((listed, position) => (position !== index) && (addressListingForm(listed) === form));
}
