import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.ts";
import { findRedactedPlaceholders } from "../src/guard.ts";
import { createLogger } from "../src/log.ts";
import { isSecretKey, redactSettings, SecretRegistry } from "../src/redact.ts";
import { VERSION } from "../src/version.ts";

describe("loadConfig", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "obs-cfg-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("defaults to localhost:4455 with no password", () => {
    expect(loadConfig({})).toMatchObject({ host: "127.0.0.1", port: 4455, password: undefined, readOnly: false, timelineRecord: true });
  });

  it("reads the first line of the password file", () => {
    const f = join(dir, "pw");
    writeFileSync(f, "s3cret-from-file\nignored\n");
    expect(loadConfig({ OBS_PASSWORD_FILE: f }).password).toBe("s3cret-from-file");
  });

  it("removes OBS_PASSWORD from the environment once read", () => {
    const env: NodeJS.ProcessEnv = { OBS_PASSWORD: "s3cret-in-env" };
    expect(loadConfig(env).password).toBe("s3cret-in-env");
    expect(env.OBS_PASSWORD).toBeUndefined();
  });

  it("rejects a host with a scheme or port, without echoing values", () => {
    expect(() => loadConfig({ OBS_HOST: "ws://example.com:4455" })).toThrow(ConfigError);
    try {
      loadConfig({ OBS_HOST: "ws://example.com:4455", OBS_PASSWORD: "dont-echo-me" });
    } catch (e) {
      expect(String(e)).not.toContain("dont-echo-me");
      expect(String(e)).not.toContain("example.com");
    }
  });

  it.each([
    ["0", false],
    ["1", true],
    ["65535", true],
    ["65536", false],
  ])("port %s valid: %s", (port, valid) => {
    if (valid) expect(loadConfig({ OBS_PORT: port }).port).toBe(Number(port));
    else expect(() => loadConfig({ OBS_PORT: port })).toThrow(ConfigError);
  });

  it("explains a missing password file without its contents", () => {
    expect(() => loadConfig({ OBS_PASSWORD_FILE: join(dir, "nope") })).toThrow(/ENOENT/);
    const empty = join(dir, "empty");
    writeFileSync(empty, "\n");
    expect(() => loadConfig({ OBS_PASSWORD_FILE: empty })).toThrow(/empty/);
  });
});

describe("redaction", () => {
  it.each(["password", "stream_key", "key", "bearer_token", "api_key", "auth", "authorization", "secret", "cookie", "server_password", "twitch_key"])(
    "%s is secret",
    (k) => expect(isSecretKey(k)).toBe(true),
  );
  it.each(["key_color", "key_color_type", "keyint_sec", "keyframes", "hotkey_bypass", "use_auth", "monitor", "server", "record_mode"])(
    "%s is not secret",
    (k) => expect(isSecretKey(k)).toBe(false),
  );

  it("redacts nested secrets and cuts URLs to their origin", () => {
    const out = redactSettings({
      key: "abc",
      empty_key: "",
      nested: { password: "p", list: [{ token: "t" }] },
      url: "https://widgets.example.com/alert/abcdef?token=1",
      bare_url: "https://example.com",
      local_file: "C:/videos/a.mp4",
      file_url: "file:///tmp/a.html",
    });
    expect(out).toEqual({
      key: "[redacted]",
      empty_key: "",
      nested: { password: "[redacted]", list: [{ token: "[redacted]" }] },
      url: "https://widgets.example.com/[redacted]",
      bare_url: "https://example.com",
      local_file: "C:/videos/a.mp4",
      file_url: "file:///tmp/a.html",
    });
  });

  it("scrubs literal secrets anywhere in text, and ignores trivially short ones", () => {
    const s = new SecretRegistry();
    s.add("hunter2-long");
    s.add("abc");
    expect(s.scrub("pw=hunter2-long; abc")).toBe("pw=[redacted]; abc");
    expect(s.scrubDeep({ a: ["x hunter2-long"] })).toEqual({ a: ["x [redacted]"] });
  });

  it("the logger scrubs secrets", () => {
    const s = new SecretRegistry();
    s.add("hunter2-long");
    const lines: string[] = [];
    createLogger(s, "debug", (l) => lines.push(l)).error("failed with hunter2-long");
    expect(lines.join("")).not.toContain("hunter2-long");
    expect(lines.join("")).toContain("[redacted]");
  });

  it("finds [redacted] placeholders sent back in settings", () => {
    expect(findRedactedPlaceholders({ a: 1, key: "[redacted]", n: { url: "https://x/[redacted]" } })).toEqual(["key", "n.url"]);
    expect(findRedactedPlaceholders({ a: "fine" })).toEqual([]);
  });
});

describe("version", () => {
  it("matches package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});
