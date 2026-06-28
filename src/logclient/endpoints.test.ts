/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * logclient/endpoints.test.ts: Unit tests for the HTTP and WebSocket URL builders.
 */
import { describe, test } from "node:test";
import { httpBaseUrl, socketUrl } from "./endpoints.ts";
import assert from "node:assert/strict";

describe("httpBaseUrl", () => {

  test("builds a plaintext origin with no trailing slash by default", () => {

    assert.equal(httpBaseUrl({ host: "localhost", port: 8581 }), "http://localhost:8581");
  });

  test("uses the https scheme when tls is true", () => {

    assert.equal(httpBaseUrl({ host: "example.com", port: 443, tls: true }), "https://example.com");
  });

  test("uses the http scheme when tls is explicitly false", () => {

    assert.equal(httpBaseUrl({ host: "example.com", port: 80, tls: false }), "http://example.com");
  });

  test("omits the default port from the origin", () => {

    // The platform URL drops the scheme's default port from the origin (80 for http, 443 for https). We assert the observable behavior rather than fighting it.
    assert.equal(httpBaseUrl({ host: "example.com", port: 80 }), "http://example.com");
    assert.equal(httpBaseUrl({ host: "example.com", port: 443, tls: true }), "https://example.com");
  });

  test("brackets an IPv6 host", () => {

    assert.equal(httpBaseUrl({ host: "::1", port: 8581 }), "http://[::1]:8581");
  });
});

describe("socketUrl", () => {

  test("builds the ws connect URL with the Engine.IO query parameters and token", () => {

    const url = new URL(socketUrl({ host: "localhost", port: 8581, token: "abc.def.ghi" }));

    assert.equal(url.protocol, "ws:");
    assert.equal(url.hostname, "localhost");
    assert.equal(url.port, "8581");
    assert.equal(url.pathname, "/socket.io/");
    assert.equal(url.searchParams.get("EIO"), "4");
    assert.equal(url.searchParams.get("transport"), "websocket");
    assert.equal(url.searchParams.get("token"), "abc.def.ghi");
  });

  test("uses the wss scheme when tls is true", () => {

    const url = new URL(socketUrl({ host: "example.com", port: 8581, tls: true, token: "t" }));

    assert.equal(url.protocol, "wss:");
  });

  test("percent-encodes a token that contains URL-unsafe characters", () => {

    // A token carrying characters that must be escaped in a query string round-trips correctly: the encoded URL re-parses to the original token, proving we did not emit
    // a raw, ambiguous query string.
    const token = "a+b/c=d&e";
    const url = new URL(socketUrl({ host: "localhost", port: 8581, token }));

    assert.equal(url.searchParams.get("token"), token);
    assert.ok(!url.toString().includes("token=a+b/c=d&e"), "an unsafe token must not appear verbatim in the serialized URL");
  });
});
