/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * logclient/config.test.ts: Unit tests for CLI-layer config loading and pure connection resolution - precedence, missing/malformed files, perms warning, HBLOG_CONFIG.
 */
import type { HblogConfigFile, HblogConnectionFlags, HblogEnv } from "./config.ts";
import { describe, test } from "node:test";
import { loadConfigFile, resolveConfigPath, resolveConnection } from "./config.ts";
import assert from "node:assert/strict";

// Build a `readFile` seam double returning a caller-supplied text, or rejecting with an ENOENT-shaped error to model a missing file. The recorded paths let a test assert
// which path the loader read.
function fakeReadFile(result: string | { code: string }): { paths: string[]; readFile: (path: string) => Promise<string> } {

  const paths: string[] = [];

  const readFile = async (path: string): Promise<string> => {

    paths.push(path);

    if(typeof result !== "string") {

      const error = new Error("ENOENT") as Error & { code: string };

      error.code = result.code;

      throw error;
    }

    return result;
  };

  return { paths, readFile };
}

// Build a `stat` seam double reporting a fixed permission mode, so the group/other-readable warning can be exercised deterministically without a real file.
function fakeStat(mode: number): (path: string) => Promise<{ readonly mode: number }> {

  return async (): Promise<{ readonly mode: number }> => ({ mode });
}

// A capturing `warn` seam: records every warning message the loader emits so a test asserts both the presence and the count of the security warning.
function capturingWarn(): { messages: string[]; warn: (message: string) => void } {

  const messages: string[] = [];

  return { messages, warn: (message: string): void => { messages.push(message); } };
}

// An owner-only permission mode (0o600 plus the regular-file type bits a real stat carries). Masked with 0o077 this yields zero, so it must NOT trigger the security
// warning. The high 0o100000 bit is the S_IFREG file-type marker a real stat reports.
const MODE_OWNER_ONLY = 0o100600;

// A group/other-readable permission mode (0o644). Masked with 0o077 this is non-zero, so it MUST trigger the single security warning.
const MODE_GROUP_READABLE = 0o100644;

describe("loadConfigFile - missing and malformed files", () => {

  test("a missing file resolves to undefined silently", async () => {

    const { readFile } = fakeReadFile({ code: "ENOENT" });
    const { messages, warn } = capturingWarn();

    const result = await loadConfigFile("/home/dev/.hblog.json", { readFile, stat: fakeStat(MODE_OWNER_ONLY), warn });

    assert.equal(result, undefined, "a missing config file must resolve to undefined, not throw");
    assert.deepEqual(messages, [], "a missing file must emit no warning");
  });

  test("a malformed JSON file throws a clear, actionable error naming the path", async () => {

    const { readFile } = fakeReadFile("{ not valid json");
    const { warn } = capturingWarn();

    await assert.rejects(loadConfigFile("/home/dev/.hblog.json", { readFile, stat: fakeStat(MODE_OWNER_ONLY), warn }), (error: Error) => {

      assert.match(error.message, /\/home\/dev\/\.hblog\.json/, "the error must name the offending path");
      assert.match(error.message, /not valid JSON/, "the error must explain the failure is a JSON parse problem");

      return true;
    });
  });

  test("a non-object JSON file (e.g. an array) throws a clear error", async () => {

    const { readFile } = fakeReadFile("[1, 2, 3]");
    const { warn } = capturingWarn();

    await assert.rejects(loadConfigFile("/home/dev/.hblog.json", { readFile, stat: fakeStat(MODE_OWNER_ONLY), warn }), /must contain a JSON object/);
  });
});

describe("loadConfigFile - parsing and unknown keys", () => {

  test("parses recognized keys by type and ignores unknown keys", async () => {

    const file = JSON.stringify({ host: "ui.local", nonsense: "ignored", port: 9000, tls: true, token: "abc", unrelated: 42, username: "admin" });
    const { readFile } = fakeReadFile(file);
    const { warn } = capturingWarn();

    const result = await loadConfigFile("/home/dev/.hblog.json", { readFile, stat: fakeStat(MODE_OWNER_ONLY), warn });

    assert.deepEqual(result, { host: "ui.local", password: undefined, port: 9000, tls: true, token: "abc", username: "admin" },
      "recognized keys must be picked out by type and unknown keys dropped");
  });

  test("ignores a recognized key whose value is the wrong type", async () => {

    const file = JSON.stringify({ host: 12345, port: "8581", tls: "yes" });
    const { readFile } = fakeReadFile(file);
    const { warn } = capturingWarn();

    const result = await loadConfigFile("/home/dev/.hblog.json", { readFile, stat: fakeStat(MODE_OWNER_ONLY), warn });

    assert.deepEqual(result, { host: undefined, password: undefined, port: undefined, tls: undefined, token: undefined, username: undefined },
      "a wrong-typed value must be treated as unset rather than coerced");
  });
});

describe("loadConfigFile - permissions warning", () => {

  test("warns exactly once when the file is group/other-readable", async () => {

    const { readFile } = fakeReadFile(JSON.stringify({ host: "ui.local" }));
    const { messages, warn } = capturingWarn();

    await loadConfigFile("/home/dev/.hblog.json", { readFile, stat: fakeStat(MODE_GROUP_READABLE), warn });

    assert.equal(messages.length, 1, "a group/other-readable file must emit exactly one warning");
    assert.match(messages[0] ?? "", /chmod 600/, "the warning must recommend chmod 600");
  });

  test("does not warn when the file is owner-only", async () => {

    const { readFile } = fakeReadFile(JSON.stringify({ host: "ui.local" }));
    const { messages, warn } = capturingWarn();

    await loadConfigFile("/home/dev/.hblog.json", { readFile, stat: fakeStat(MODE_OWNER_ONLY), warn });

    assert.deepEqual(messages, [], "an owner-only file must emit no security warning");
  });

  test("a stat failure does not fail an otherwise-valid load", async () => {

    const { readFile } = fakeReadFile(JSON.stringify({ host: "ui.local" }));
    const { messages, warn } = capturingWarn();

    const failingStat = async (): Promise<{ readonly mode: number }> => { throw new Error("stat unavailable"); };

    const result = await loadConfigFile("/home/dev/.hblog.json", { readFile, stat: failingStat, warn });

    assert.equal(result?.host, "ui.local", "the load must succeed even when permissions cannot be determined");
    assert.deepEqual(messages, [], "a stat failure must skip the warning rather than emit it");
  });
});

describe("resolveConfigPath - HBLOG_CONFIG override", () => {

  test("HBLOG_CONFIG overrides the default home path", () => {

    const path = resolveConfigPath({ env: { HBLOG_CONFIG: "/custom/path/hblog.json" }, homedir: "/home/dev" });

    assert.equal(path, "/custom/path/hblog.json", "a non-empty HBLOG_CONFIG must override the default path");
  });

  test("an empty HBLOG_CONFIG falls back to the default home path", () => {

    const path = resolveConfigPath({ env: { HBLOG_CONFIG: "" }, homedir: "/home/dev" });

    assert.equal(path, "/home/dev/.hblog.json", "an empty HBLOG_CONFIG must not override; the default home path applies");
  });

  test("the default path joins the home directory and the dotfile, trimming a trailing separator", () => {

    assert.equal(resolveConfigPath({ env: {}, homedir: "/home/dev" }), "/home/dev/.hblog.json", "the default path must be <home>/.hblog.json");
    assert.equal(resolveConfigPath({ env: {}, homedir: "/home/dev/" }), "/home/dev/.hblog.json", "a trailing separator on the home directory must be trimmed");
  });
});

describe("resolveConnection - precedence", () => {

  // A representative config file used across the precedence tests.
  const file: HblogConfigFile = { host: "file.host", password: "file.pass", port: 1111, tls: true, token: "file.token", username: "file.user" };
  const env: HblogEnv = { host: "env.host", otp: "env.otp", password: "env.pass", port: "2222", token: "env.token", username: "env.user" };
  const flags: HblogConnectionFlags = { host: "flag.host", otp: "flag.otp", password: "flag.pass", port: 3333, tls: false, token: "flag.token", username: "flag.user" };

  test("flags win over env, file, and defaults", () => {

    const resolved = resolveConnection({ env, file, flags });

    assert.deepEqual(resolved, { host: "flag.host", otp: "flag.otp", password: "flag.pass", port: 3333, tls: false, token: "flag.token", username: "flag.user" },
      "every field present in the flags must win outright");
  });

  test("env wins over file and defaults when no flag is set", () => {

    const resolved = resolveConnection({ env, file, flags: {} });

    assert.deepEqual(resolved, { host: "env.host", otp: "env.otp", password: "env.pass", port: 2222, tls: true, token: "env.token", username: "env.user" },
      "env must win over the file (and the env port string must be parsed); tls comes from the file since env carries none");
  });

  test("file wins over defaults when no flag or env is set", () => {

    const resolved = resolveConnection({ env: {}, file, flags: {} });

    assert.deepEqual(resolved, { host: "file.host", otp: null, password: "file.pass", port: 1111, tls: true, token: "file.token", username: "file.user" },
      "the file must supply every value (otp is null since the file carries none)");
  });

  test("defaults apply when no source supplies a value", () => {

    const resolved = resolveConnection({ env: {}, file: undefined, flags: {} });

    assert.deepEqual(resolved, { host: "localhost", otp: null, password: null, port: 8581, tls: false, token: null, username: null },
      "with no source, host/port/tls take their defaults and the credential fields are null");
  });

  test("a non-numeric env port is ignored and falls through to the next source", () => {

    const resolved = resolveConnection({ env: { port: "not-a-number" }, file: { port: 4444 }, flags: {} });

    assert.equal(resolved.port, 4444, "a non-numeric HBLOG_PORT must be discarded so it does not mask the file's port with NaN");
  });

  test("a flag port wins over a valid env port", () => {

    const resolved = resolveConnection({ env: { port: "2222" }, file: undefined, flags: { port: 3333 } });

    assert.equal(resolved.port, 3333, "the flag port must take precedence over the env port");
  });
});
