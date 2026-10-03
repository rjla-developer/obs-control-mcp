import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeObs } from "./fakeObs.ts";
import { PASSWORD } from "./harness.ts";

/**
 * The real process, as an MCP client launches it, with DEBUG=* set (the trap
 * that makes obs-websocket-js print every message): nothing it writes to
 * stdout or stderr may contain the password or a stream key.
 */

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

describe("the real process never prints secrets", () => {
  let dir: string;
  let fake: FakeObs;
  let pwFile: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "obs-e2e-"));
    pwFile = join(dir, "pw");
    writeFileSync(pwFile, PASSWORD + "\n", { mode: 0o600 });
    fake = new FakeObs({ password: PASSWORD });
    await fake.start();
  });
  afterEach(async () => {
    await fake.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const env = (extra: Record<string, string> = {}): Record<string, string> => ({
    PATH: process.env.PATH ?? "",
    OBS_HOST: "127.0.0.1",
    OBS_PORT: String(fake.port),
    OBS_PASSWORD_FILE: pwFile,
    DEBUG: "*",
    ...extra,
  });

  it("MCP server over stdio, with the timeline recorder on", async () => {
    const timeline = join(dir, "timeline.jsonl");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI],
      env: env({ OBS_TIMELINE_FILE: timeline }),
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    const client = new Client({ name: "e2e", version: "0.0.0" });
    await client.connect(transport);
    let stdout = "";
    for (const name of ["get_overview", "list_inputs", "list_filters", "get_outputs", "check_source_record"]) {
      const r = (await client.callTool({ name, arguments: name === "list_inputs" ? { includeSettings: true } : {} })) as {
        content: Array<{ text: string }>;
      };
      stdout += r.content.map((c) => c.text).join("");
    }
    fake.emit("CurrentProgramSceneChanged", { sceneName: "BRB" });
    await new Promise((r) => setTimeout(r, 200));
    await client.close();
    await new Promise((r) => setTimeout(r, 200));

    const everything = stdout + stderr + readFileSync(timeline, "utf8");
    expect(everything).not.toContain(PASSWORD);
    expect(everything).not.toContain("fake_stream_key_987");
    expect(everything).not.toContain("fake_sr_key_abc");
    expect(stderr).not.toMatch(/obs-websocket-js/); // DEBUG output stayed off
    expect(stderr).toMatch(/ready/);
    expect(readFileSync(timeline, "utf8")).toMatch(/CurrentProgramSceneChanged/);
  });

  it("`check` with a wrong password fails clearly without printing either password", async () => {
    const wrongFile = join(dir, "wrong");
    writeFileSync(wrongFile, "Wrong-Password-5678\n");
    const { code, out } = await run([CLI, "check"], env({ OBS_PASSWORD_FILE: wrongFile }));
    expect(code).toBe(3);
    expect(out).toMatch(/rejected the password/);
    expect(out).not.toContain("Wrong-Password-5678");
    expect(out).not.toContain(PASSWORD);
  });

  it("`check-irl` prints the verdict as JSON (not ready with the default scenes)", async () => {
    const { code, out } = await run([CLI, "check-irl"], env());
    expect(code).toBe(2);
    expect(out).toMatch(/"verdict": "not_ready"/);
    expect(out).not.toContain(PASSWORD);
    expect(out).not.toContain("fake_stream_key_987");
  });

  it("`brb` refuses to start without its scenes, and `--help` needs no OBS", async () => {
    const help = await run([CLI, "brb", "--help"], { PATH: process.env.PATH ?? "" });
    expect(help.code).toBe(0);
    expect(help.out).toMatch(/--apply/);
    const { code, out } = await run([CLI, "brb"], env());
    expect(code).toBe(3);
    expect(out).toMatch(/No scene named «IRL»/);
    expect(out).not.toContain(PASSWORD);
    expect(fake.mutations).toEqual([]);
  });

  it("`check` prints the verdict as JSON", async () => {
    const { code, out } = await run([CLI, "check"], env());
    expect(code).toBe(1); // ready_with_warnings: the screen capture has no audio
    expect(out).toMatch(/"verdict": "ready_with_warnings"/);
    expect(out).not.toContain(PASSWORD);
  });
});

function run(args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d: Buffer) => (out += d.toString()));
    p.stderr.on("data", (d: Buffer) => (out += d.toString()));
    p.on("close", (code) => resolve({ code, out }));
  });
}
