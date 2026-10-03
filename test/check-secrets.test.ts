import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain JS script without type declarations
import { scanRepo, scanText } from "../scripts/check-secrets.mjs";

type Finding = { kind: string; match: string; file?: string; line?: number };
const scan = scanText as (text: string, extra?: string[]) => Finding[];

// Samples are assembled at run time so this file itself stays clean.
const j = (...p: string[]) => p.join("");

describe("check-secrets", () => {
  it("the repository is clean", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const found = (scanRepo as (r: string) => Finding[])(root);
    expect(found.map((f) => `${f.file}:${f.line} ${f.kind}`)).toEqual([]);
  });

  it.each([
    ["IP address", j("192", ".168.", "1.50")],
    ["IP address", j("10", ".0.0.", "7:4455")],
    ["home directory path", j("/Use", "rs/", "alice/x")],
    ["home directory path", j("C:", "\\Users\\", "bob\\Videos")],
    ["e-mail address", j("someone", "@", "gmail.com")],
    ["GitHub token", j("gh", "p_", "a".repeat(36))],
    ["Private key", j("-----BEGIN ", "RSA PRIVATE", " KEY-----")],
  ])("flags %s", (kind, sample) => {
    expect(scan(`x ${sample} y`).map((f) => f.kind)).toContain(kind);
  });

  it.each(["127.0.0.1", "192.0.2.10", "C:/Users/example/Videos", "noreply@example.com", "version 5.7.4", "ws://localhost:4455"])(
    "allows %s",
    (sample) => expect(scan(sample)).toEqual([]),
  );

  it("flags extra forbidden strings", () => {
    expect(scan("hello my-lan-box", ["my-lan-box"]).map((f) => f.kind)).toEqual(["forbidden string"]);
  });
});
