/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webui/address.test.ts: Contract tests for the listed-address rule - the literal listing form of each spelling the rule folds or refuses, the default port it
 * folds under each scheme, and the listed-elsewhere answer for adds, edits, the exact-self exemption, values with no form, lists holding values that are not
 * strings, and a plugin dialing `http`.
 */
import type { AddressFormOptions, AddressListedOptions } from "./address.ts";
import { addressListedElsewhere, addressListingForm } from "./address.ts";
import { describe, test } from "node:test";
import type { Nullable } from "../util.ts";
import assert from "node:assert/strict";

// A form row asserts the literal form string, so a wrong form fails its own row whatever its twin answers.
interface FormRow {

  readonly answer: Nullable<string>;
  readonly input: unknown;
  readonly label: string;
  readonly options?: AddressFormOptions;
}

interface ListedRow {

  readonly answer: boolean;
  readonly label: string;
  readonly options: AddressListedOptions;
}

describe("addressListingForm", () => {

  const rows: readonly FormRow[] = [

    { answer: "unifi.local", input: "unifi.local", label: "a bare host name answers itself" },
    { answer: "unifi.local", input: " UNIFI.local ", label: "surrounding space and letter case fold away" },
    { answer: "unifi.local", input: "unifi.local.", label: "a trailing dot folds away" },
    { answer: "unifi.local", input: "unifi.local:443", label: "a host written with the HTTPS default port folds to the bare host" },
    { answer: "unifi.local", input: "unifi.local:", label: "an empty port folds away" },
    { answer: "unifi.local:8443", input: "unifi.local:8443", label: "a port other than the default stays in the form" },
    { answer: "[fe80::1]", input: "fe80::1", label: "a bare IPv6 literal answers its bracketed form" },
    { answer: "[fe80::1]", input: "[fe80::1]", label: "a bracketed IPv6 literal answers itself" },
    { answer: "[fe80::1]", input: "FE80:0:0:0:0:0:0:1", label: "an uncompressed upper-case IPv6 literal folds to its compressed form" },
    { answer: "[fe80::1]", input: "[fe80::1]:443", label: "a bracketed IPv6 literal on the default port drops the port" },
    { answer: "[fe80::1]:8443", input: "[fe80::1]:8443", label: "a bracketed IPv6 literal keeps a port other than the default" },
    { answer: "10.0.0.1", input: "10.1", label: "IPv4 shorthand folds to the dotted quad" },
    { answer: "10.0.0.1", input: "0x0a.0.0.1", label: "a hexadecimal IPv4 part folds to the dotted quad" },
    { answer: "gw.local", input: "gw.local:80", label: "a host written with the HTTP default port folds to the bare host under http", options: { scheme: "http" } },
    { answer: "gw.local:443", input: "gw.local:443", label: "a host written with the HTTPS default port keeps that port under http", options: { scheme: "http" } },
    { answer: "gw.local:8080", input: "gw.local:8080", label: "a port other than the HTTP default stays in the form under http", options: { scheme: "http" } },
    { answer: "[fe80::1]", input: "[fe80::1]:80", label: "a bracketed IPv6 literal on the HTTP default port drops the port under http", options: { scheme: "http" } },
    { answer: "10.0.0.1", input: "10.1:80", label: "IPv4 shorthand on the HTTP default port folds to the dotted quad under http", options: { scheme: "http" } },
    { answer: null, input: 42, label: "a number has no form" },
    { answer: null, input: null, label: "null has no form" },
    { answer: null, input: undefined, label: "undefined has no form" },
    { answer: null, input: "", label: "the empty string has no form" },
    { answer: null, input: "   ", label: "a value of spaces alone has no form" },
    { answer: null, input: "a b", label: "a host holding a space has no form" },
    { answer: null, input: "fe80::1%en0", label: "a zoned bare IPv6 literal has no form" },
    { answer: null, input: "[fe80::1%25en0]", label: "a zoned bracketed IPv6 literal has no form" },
    { answer: null, input: "https://unifi.local", label: "a value carrying a scheme has no form" },
    { answer: null, input: "unifi.local/path", label: "a value carrying a path has no form" },
    { answer: null, input: "unifi.local?x", label: "a value carrying a query has no form" },
    { answer: null, input: "unifi.local?", label: "a value carrying an empty query has no form" },
    { answer: null, input: "unifi.local#x", label: "a value carrying a fragment has no form" },
    { answer: null, input: "unifi.local#", label: "a value carrying an empty fragment has no form" },
    { answer: null, input: "admin@unifi.local", label: "a value carrying a username has no form" },
    { answer: null, input: "admin:pw@unifi.local", label: "a value carrying a username and a password has no form" },
    { answer: null, input: ":pw@unifi.local", label: "a value carrying a password alone has no form" },
    { answer: null, input: ".", label: "the lone dot has no form" },
    { answer: "unifi.local:8443", input: "unifi.local.:8443", label: "a trailing dot folds away before a port other than the default" },
    { answer: "unifi.local.", input: "unifi.local..", label: "only one trailing dot is removed" },
    { answer: "unifi.local", input: "@unifi.local", label: "an empty credentials marker folds away" }
  ];

  for(const row of rows) {

    test(row.label, () => {

      assert.equal(addressListingForm(row.input, row.options), row.answer);
    });
  }
});

describe("addressListedElsewhere", () => {

  const rows: readonly ListedRow[] = [

    { answer: true, label: "an add of a listed host name in another spelling is listed elsewhere",
      options: { address: "UNIFI.local.", addresses: [ "unifi.local", "fe80::1" ], index: -1 } },
    { answer: true, label: "an add of a listed IPv6 literal in another spelling is listed elsewhere",
      options: { address: "[fe80::1]", addresses: [ "unifi.local", "fe80::1" ], index: -1 } },
    { answer: false, label: "an add of a free address is not listed elsewhere", options: { address: "10.0.0.9", addresses: ["10.0.0.1"], index: -1 } },
    { answer: false, label: "a kept port is listed apart from the same host bare", options: { address: "unifi.local:8443", addresses: ["unifi.local"], index: -1 } },
    { answer: true, label: "an add of a host written with the HTTPS default port beside the same host bare is listed elsewhere",
      options: { address: "unifi.local:443", addresses: ["unifi.local"], index: -1 } },
    { answer: true, label: "an add of a host written with the HTTP default port beside the same host bare is listed elsewhere under http",
      options: { address: "gw.local:80", addresses: ["gw.local"], index: -1, scheme: "http" } },
    { answer: false, label: "an add of a host written with the HTTPS default port beside the same host bare is not listed elsewhere under http",
      options: { address: "gw.local:443", addresses: ["gw.local"], index: -1, scheme: "http" } },
    { answer: true, label: "an add of a bare host beside the same host written with the HTTP default port is listed elsewhere under http",
      options: { address: "gw.local", addresses: ["gw.local:80"], index: -1, scheme: "http" } },
    { answer: false, label: "the exact value at the target is exempt beside its twin",
      options: { address: "10.0.0.1", addresses: [ "10.0.0.1", "10.0.0.1" ], index: 0 } },
    { answer: true, label: "a case-only edit of the target beside a twin in that spelling is listed elsewhere",
      options: { address: "UNIFI.local", addresses: [ "unifi.local", "UNIFI.local" ], index: 0 } },
    { answer: false, label: "an edit of the target to a new spelling of its own address with no twin is not listed elsewhere",
      options: { address: "unifi.local:443", addresses: [ "unifi.local", "10.0.0.1" ], index: 0 } },
    { answer: false, label: "an exact twin of a value with a scheme is accepted, having no form",
      options: { address: "https://unifi.local", addresses: ["https://unifi.local"], index: -1 } },
    { answer: false, label: "an exact twin of the lone dot is accepted, having no form", options: { address: ".", addresses: ["."], index: -1 } },
    { answer: true, label: "a listed address beside values that are not strings is listed elsewhere",
      options: { address: "10.0.0.1", addresses: [ null, 42, undefined, "10.0.0.1" ], index: -1 } },
    { answer: false, label: "a free address beside values that are not strings is not listed elsewhere",
      options: { address: "10.0.0.2", addresses: [ null, 42, "10.0.0.1" ], index: -1 } }
  ];

  for(const row of rows) {

    test(row.label, () => {

      assert.equal(addressListedElsewhere(row.options), row.answer);
    });
  }
});
