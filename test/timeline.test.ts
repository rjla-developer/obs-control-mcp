import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../src/log.ts";
import { ObsConnection, TIMELINE_SUBSCRIPTIONS } from "../src/obs.ts";
import { SecretRegistry } from "../src/redact.ts";
import { acquireTimelineLock, parseTimeline, summarizeTimeline, TimelineRecorder, TimelineWriter } from "../src/timeline.ts";
import { FakeObs } from "./fakeObs.ts";
import { PASSWORD, startHarness, type Harness } from "./harness.ts";

const L = (o: object) => JSON.stringify(o);
const SAMPLE = [
  L({ t: "2026-01-01T20:00:00.000Z", type: "recorder", state: "started" }),
  L({ t: "2026-01-01T20:00:00.000Z", type: "recorder", state: "connected" }),
  L({ t: "2026-01-01T20:00:00.000Z", type: "snapshot", programScene: "Intro", streaming: false, recording: false }),
  L({ t: "2026-01-01T20:01:00.000Z", type: "event", event: "StreamStateChanged", data: { outputActive: true, outputState: "OBS_WEBSOCKET_OUTPUT_STARTED" } }),
  L({ t: "2026-01-01T20:02:00.000Z", type: "event", event: "CurrentProgramSceneChanged", data: { sceneName: "Main" } }),
  L({ t: "2026-01-01T20:10:00.000Z", type: "event", event: "CurrentProgramSceneChanged", data: { sceneName: "Screen" } }),
  "not json",
  L({ t: "2026-01-01T20:15:00.000Z", type: "event", event: "CurrentProgramSceneChanged", data: { sceneName: "Main" } }),
  L({ t: "2026-01-01T20:30:00.000Z", type: "event", event: "StreamStateChanged", data: { outputActive: false, outputState: "OBS_WEBSOCKET_OUTPUT_STOPPED" } }),
  L({ t: "2026-01-01T20:31:00.000Z", type: "recorder", state: "stopped" }),
].join("\n");

describe("summarizeTimeline", () => {
  const sum = (opts = {}) => summarizeTimeline("t.jsonl", SAMPLE, { now: new Date("2026-01-01T21:00:00Z"), ...opts });

  it("builds scene segments with stream offsets", () => {
    const s = sum();
    expect(s.badLines).toBe(1);
    // Segments split where the stream starts/stops, so each is wholly in or out of it.
    expect(s.segments.map((x) => [x.scene, x.durationSec, x.streamOffsetSec ?? null, x.endReason])).toEqual([
      ["Intro", 60, null, "output_change"],
      ["Intro", 60, 0, "scene_change"],
      ["Main", 480, 60, "scene_change"],
      ["Screen", 300, 540, "scene_change"],
      ["Main", 900, 840, "output_change"],
      ["Main", 60, null, "recorder_gap"],
    ]);
    expect(s.timePerScene).toEqual({ Intro: 120, Main: 1440, Screen: 300 });
    expect(s.streams).toEqual([{ start: "2026-01-01T20:01:00.000Z", end: "2026-01-01T20:30:00.000Z", durationSec: 1740 }]);
  });

  it("answers what was live at a time", () => {
    expect(sum({ at: "2026-01-01T20:12:00Z" }).at).toEqual({
      time: "2026-01-01T20:12:00.000Z",
      scene: "Screen",
      streaming: true,
      recording: false,
      streamOffsetSec: 660,
    });
  });

  it("answers what was live at a second of the stream (VOD timestamp)", () => {
    // 10 min into the stream = 20:11 → Screen
    expect(sum({ atStreamOffsetSec: 600 }).at?.scene).toBe("Screen");
    // segment boundary: exactly at 20:10:00 the new scene is live
    expect(sum({ atStreamOffsetSec: 540 }).at?.scene).toBe("Screen");
    expect(sum({ atStreamOffsetSec: 539.9 }).at?.scene).toBe("Main");
  });

  it("filters by window", () => {
    const s = sum({ from: "2026-01-01T20:11:00Z", to: "2026-01-01T20:14:00Z" });
    expect(s.segments.map((x) => x.scene)).toEqual(["Screen"]);
  });

  it("a snapshot taken mid-stream keeps offsets on the stream clock", () => {
    const text = L({ t: "2026-01-01T20:10:00.000Z", type: "snapshot", programScene: "Main", streaming: true, recording: false, streamDurationMs: 600000 });
    const s = summarizeTimeline("t", text, { now: new Date("2026-01-01T20:20:00Z") });
    expect(s.streams[0]!.start).toBe("2026-01-01T20:00:00.000Z");
    expect(s.segments[0]!.streamOffsetSec).toBe(600);
    expect(s.segments[0]!.durationSec).toBe(600);
  });

  it("an open segment ends now", () => {
    const text = [
      L({ t: "2026-01-01T20:00:00.000Z", type: "snapshot", programScene: "Main", streaming: true, recording: false }),
    ].join("\n");
    const s = summarizeTimeline("t", text, { now: new Date("2026-01-01T20:05:00Z") });
    expect(s.segments).toEqual([{ scene: "Main", start: "2026-01-01T20:00:00.000Z", end: null, durationSec: 300, streamOffsetSec: 0, endReason: "open" }]);
    expect(s.streams[0]!.end).toBeNull();
  });
});

describe("timeline lock", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "obs-timeline-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("only one recorder per file; a stale lock is taken over", () => {
    const file = join(dir, "t.jsonl");
    const release = acquireTimelineLock(file);
    expect(release).toBeTypeOf("function");
    // Our own pid holds it: a second acquire from "another process" is simulated by writing a live foreign pid.
    release!();
    writeFileSync(`${file}.lock`, String(process.ppid));
    expect(acquireTimelineLock(file)).toBeUndefined();
    writeFileSync(`${file}.lock`, "999999999");
    const again = acquireTimelineLock(file);
    expect(again).toBeTypeOf("function");
    again!();
  });
});

describe("TimelineRecorder against the fake OBS", () => {
  let dir: string;
  let fake: FakeObs;
  let conn: ObsConnection;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "obs-timeline-"));
    fake = new FakeObs({ password: PASSWORD });
    await fake.start();
  });
  afterEach(async () => {
    await conn?.close();
    await fake.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes a snapshot and every event as redacted JSON lines", async () => {
    const file = join(dir, "sub", "timeline.jsonl");
    const secrets = new SecretRegistry();
    secrets.add(PASSWORD);
    const logs: string[] = [];
    const logger = createLogger(secrets, "debug", (l) => logs.push(l));
    conn = new ObsConnection({
      config: { host: "127.0.0.1", port: fake.port, password: PASSWORD, connectTimeoutMs: 2000 },
      secrets,
      logger,
      eventSubscriptions: TIMELINE_SUBSCRIPTIONS,
      autoReconnect: true,
    });
    const rec = new TimelineRecorder(conn, new TimelineWriter(file, secrets), logger);
    rec.start();
    await conn.ensureConnected();
    await waitFor(() => readFileSync(file, "utf8").includes('"snapshot"'));

    fake.emit("CurrentProgramSceneChanged", { sceneName: "BRB", sceneUuid: "x" });
    fake.emit("StreamStateChanged", { outputActive: true, outputState: "OBS_WEBSOCKET_OUTPUT_STARTED" });
    fake.emit("InputSettingsChanged", { inputName: "Alerts", inputSettings: { url: "https://alerts.example.com/widget/TOKEN123", stream_key: "fake" } });
    fake.emit("SceneItemEnableStateChanged", { sceneName: "Main", sceneItemId: 2, sceneItemEnabled: false });
    fake.emit("InputVolumeMeters", { inputs: [] }); // not subscribed: must be ignored
    await waitFor(() => readFileSync(file, "utf8").includes("SceneItemEnableStateChanged"));
    rec.stop("test");

    const text = readFileSync(file, "utf8");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(text).not.toContain("TOKEN123");
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain("InputVolumeMeters");
    const { lines, bad } = parseTimeline(text);
    expect(bad).toBe(0);
    const events = lines.filter((l) => l.type === "event") as Array<{ event: string; data: Record<string, unknown> }>;
    expect(events.map((e) => e.event)).toEqual([
      "CurrentProgramSceneChanged",
      "StreamStateChanged",
      "InputSettingsChanged",
      "SceneItemEnableStateChanged",
    ]);
    expect(events[3]!.data.sourceName).toBe("Screen");
    expect(lines.find((l) => l.type === "snapshot")).toMatchObject({ programScene: "Main", streaming: false });

    const summary = summarizeTimeline(file, text);
    // (BRB is split where the stream starts, unless both land in the same millisecond)
    const scenes = summary.segments.map((s) => s.scene).filter((x, i, a) => x !== a[i - 1]);
    expect(scenes).toEqual(["Main", "BRB"]);
    expect(summary.segments.at(-1)!.streamOffsetSec).toBe(0);
  });

  it("logs the drop and reconnects with a new snapshot", async () => {
    const file = join(dir, "timeline.jsonl");
    const secrets = new SecretRegistry();
    const logger = createLogger(secrets, "debug", () => undefined);
    conn = new ObsConnection({
      config: { host: "127.0.0.1", port: fake.port, password: PASSWORD, connectTimeoutMs: 2000 },
      secrets,
      logger,
      eventSubscriptions: TIMELINE_SUBSCRIPTIONS,
      autoReconnect: true,
    });
    const rec = new TimelineRecorder(conn, new TimelineWriter(file, secrets), logger);
    rec.start();
    conn.keepConnected();
    await waitFor(() => readFileSync(file, "utf8").includes('"snapshot"'));
    fake.dropClients();
    await waitFor(() => (readFileSync(file, "utf8").match(/"snapshot"/g) ?? []).length >= 2, 5000);
    const states = parseTimeline(readFileSync(file, "utf8")).lines.filter((l) => l.type === "recorder").map((l) => (l as { state: string }).state);
    expect(states).toEqual(["started", "connected", "disconnected", "connected"]);
  });
});

describe("read_timeline tool", () => {
  let h: Harness | undefined;
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "obs-timeline-"));
  });
  afterEach(async () => {
    await h?.close();
    h = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it("summarises the configured file", async () => {
    const file = join(dir, "t.jsonl");
    writeFileSync(file, SAMPLE);
    h = await startHarness({ timelineFile: file });
    const r = await h.call("read_timeline", { atStreamOffsetSec: 600, tail: 2 });
    expect(r.isError).toBe(false);
    expect(r.json.at.scene).toBe("Screen");
    expect(r.json.tail).toHaveLength(2);
  });

  it("explains when nothing is configured or recorded", async () => {
    h = await startHarness();
    expect((await h.call("read_timeline")).text).toMatch(/OBS_TIMELINE_FILE/);
    await h.close();
    h = await startHarness({ timelineFile: join(dir, "missing.jsonl") });
    expect((await h.call("read_timeline")).text).toMatch(/does not exist yet/);
    expect((await h.call("read_timeline", { at: "yesterday-ish" })).isError).toBe(true);
  });
});

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      if (cond()) return;
    } catch {
      // file not there yet
    }
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}
